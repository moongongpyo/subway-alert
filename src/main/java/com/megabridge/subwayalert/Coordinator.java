package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.Models.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import jakarta.annotation.PreDestroy;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

@Service
public class Coordinator {
    private final Store store;
    private final SeoulClient seoul;
    private final AgentGateway agents;
    private final ExecutorService executor=Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy=new AtomicBoolean();
    private volatile Mode mode;
    @Value("${app.fresh-seconds}") private int freshSeconds;
    @Value("${app.demo-seed}") private boolean seed;
    public Coordinator(Store store,SeoulClient seoul,AgentGateway agents,@Value("${app.mode}") Mode mode) {
        this.store=store; this.seoul=seoul; this.agents=agents; this.mode=mode;
    }
    public Mode mode() { return mode; }
    public boolean busy() { return busy.get(); }
    public int freshness() { return freshSeconds; }
    public synchronized void setMode(Mode next) {
        if(busy()) throw new IllegalStateException("현재 검증이 끝난 뒤 모드를 바꿔주세요.");
        if(next==Mode.LIVE && (!seoul.configured() || !agents.configured())) throw new IllegalArgumentException("서울시 키와 두 AI 에이전트 연결을 먼저 설정하세요.");
        mode=next;
    }
    @EventListener(ApplicationReadyEvent.class)
    public void startup() {
        // An interrupted job must not look as though it is still progressing after restart.
        store.list("run",null,1000,Run.class).stream().filter(r->Set.of("PENDING","RUNNING").contains(r.state()))
                .forEach(r->save(new Run(r.id(),r.mode(),r.scenario(),"INTERRUPTED","서버 재시작으로 보류됨",r.startedAt(),Instant.now())));
        store.list("job",null,1000,AgentJob.class).stream().filter(j->Set.of("PENDING","RUNNING").contains(j.state()))
                .forEach(j->store.put(j.id(),"job",j.runId(),new AgentJob(j.id(),j.runId(),j.role(),"FAILED",j.engine(),"서버 재시작으로 보류됨",j.createdAt(),Instant.now())));
        if(seed && mode==Mode.DEMO && store.list("observation",null,1,Observation.class).isEmpty())
            for(String s:STATIONS) for(String d:DIRECTIONS) persist(DemoFactory.samples(s,d,Scenario.NORMAL,UUID.randomUUID().toString()));
    }
    @Scheduled(fixedDelayString="${app.poll-ms}",initialDelayString="${app.poll-ms}")
    public void poll() {
        if(mode==Mode.LIVE && !busy()) {
            try { start(null,null,null,UUID.randomUUID().toString()); } catch(IllegalStateException ignored) { }
        }
        store.prune();
    }
    public synchronized Run start(Scenario scenario,String station,String direction,String requestId) {
        if(requestId==null || !requestId.matches("[A-Za-z0-9-]{8,80}")) throw new IllegalArgumentException("유효한 요청 ID가 필요합니다.");
        if(mode==Mode.DEMO && (scenario==null || !STATIONS.contains(station) || !DIRECTIONS.contains(direction))) throw new IllegalArgumentException("시연할 역·방향·상황을 선택하세요.");
        if(mode==Mode.LIVE && scenario!=null) throw new IllegalArgumentException("시연 상황은 DEMO 모드에서만 실행할 수 있습니다.");
        String id="run-"+requestId;
        var existing=store.get(id,"run",Run.class);
        if(existing.isPresent()) return existing.get();
        if(!busy.compareAndSet(false,true)) throw new IllegalStateException("다른 검증이 진행 중입니다.");
        Run run=new Run(id,mode,scenario==null?"LIVE_POLL":scenario.name(),"PENDING","수집 대기",Instant.now(),null);
        try {
            save(run);
            executor.submit(()->execute(run,scenario,station,direction));
        } catch(RuntimeException e) { busy.set(false); throw e; }
        return run;
    }
    private void execute(Run run,Scenario scenario,String station,String direction) {
        save(new Run(run.id(),run.mode(),run.scenario(),"RUNNING","수집 및 검증 중",run.startedAt(),null));
        try {
            if(run.mode()==Mode.DEMO) {
                List<Observation> samples=DemoFactory.samples(station,direction,scenario,run.id());
                persist(samples);
                process(run,station,direction,samples,scenario!=Scenario.FAILURE,scenario);
            } else {
                List<Observation> rows=List.of();
                String error="";
                for(int retry=0;retry<2;retry++) {
                    try { rows=seoul.collect(STATIONS); error=""; break; }
                    catch(Exception e) { error=e.getMessage(); message(run,"", "collector","server","COLLECTION_RETRY",error,retry); }
                }
                persist(rows);
                for(String s:STATIONS) for(String d:DIRECTIONS) {
                    String st=s,dr=d;
                    boolean healthy=error.isEmpty() && rows.stream().anyMatch(o->o.station().equals(st)&&o.direction().equals(dr));
                    process(run,s,d,store.list("observation",scope(run.mode(),s,d),100,Observation.class),healthy,null);
                }
            }
            save(new Run(run.id(),run.mode(),run.scenario(),"SUCCEEDED","수집·판정 완료 · 구간별 결과를 확인하세요",run.startedAt(),Instant.now()));
        } catch(Exception e) {
            save(new Run(run.id(),run.mode(),run.scenario(),"FAILED","작업 실패 · 안전을 위해 알림 보류",run.startedAt(),Instant.now()));
        } finally { busy.set(false); }
    }
    private void process(Run run,String station,String direction,List<Observation> rows,boolean healthy,Scenario scenario) {
        String scope=scope(run.mode(),station,direction);
        Incident prior=store.list("incident",scope,1,Incident.class).stream().findFirst().orElse(null);
        boolean continuing=prior!=null && !Set.of("NORMAL","OBSERVING","RECOVERED").contains(prior.state());
        String incidentId=continuing?prior.id():"incident-"+UUID.randomUUID();
        Instant created=continuing?prior.createdAt():Instant.now();
        var assessment=EvidenceRules.assess(rows,Instant.now(),freshSeconds);
        String state=assessment.evidenceIds().size()<3?"OBSERVING":"NORMAL",reason=assessment.reason();
        List<String> evidence=assessment.evidenceIds();
        if(!healthy || !assessment.fresh()) {
            state="DATA_UNAVAILABLE";
            reason=healthy?assessment.reason():"수집 실패 또는 매칭할 관측 없음 · 열차 장애로 판단하지 않음";
            message(run,incidentId,"collector","verifier","COLLECTION_ERROR",reason,0);
            // Error scenarios still show the verifier's inspection, but can never emit an alert.
            if(run.mode()==Mode.DEMO) try { call(run,incidentId,"verifier",station,direction,0,healthy,rows); } catch(Exception ignored) { }
        } else if(assessment.candidate()) {
            state="VERIFY_PENDING";
            try {
                for(int attempt=0;attempt<=2;attempt++) {
                    message(run,incidentId,"server","detector","ANALYZE","새 관측으로 후보 재검사",attempt);
                    AgentResult detector=call(run,incidentId,"detector",station,direction,attempt,true,rows);
                    if(scenario==Scenario.TIMEOUT) throw new java.net.http.HttpTimeoutException("시연: 검증 에이전트 타임아웃");
                    if(scenario==Scenario.INVALID_RESPONSE) throw new IllegalArgumentException("시연: 잘못된 에이전트 JSON");
                    if(detector.verdict()==Verdict.COLLECTION_ERROR) { state="DATA_UNAVAILABLE"; reason=detector.reason(); break; }
                    if(detector.verdict()==Verdict.REJECTED) { state="REJECTED"; reason=detector.reason(); break; }
                    message(run,incidentId,"detector","verifier","VERIFY_CANDIDATE",detector.reason(),attempt);
                    AgentResult verified=call(run,incidentId,"verifier",station,direction,attempt,true,rows);
                    if(verified.verdict()==Verdict.ALERT_ALLOWED && detector.verdict()==Verdict.ALERT_ALLOWED) {
                        Set<String> detectorIds=new HashSet<>(detector.evidenceIds());
                        List<Observation> verifiedRows=rows.stream().filter(o->verified.evidenceIds().contains(o.id())&&detectorIds.contains(o.id())).toList();
                        var gate=EvidenceRules.assess(verifiedRows,Instant.now(),freshSeconds);
                        if(gate.fresh() && gate.candidate()) { state="DELAY_SUSPECTED"; reason="같은 열차의 위치 유지와 도착예정시간 증가를 최신 관측으로 재확인했습니다."; evidence=gate.evidenceIds(); }
                        else reason="두 에이전트의 공통 근거가 발송 조건을 충족하지 않아 보류했습니다.";
                        break;
                    }
                    if(verified.verdict()!=Verdict.NEEDS_MORE_DATA && detector.verdict()!=Verdict.NEEDS_MORE_DATA) {
                        state=verified.verdict()==Verdict.COLLECTION_ERROR?"DATA_UNAVAILABLE":"REJECTED"; reason=verified.reason(); break;
                    }
                    if(attempt==2) { reason="최대 2회 재조회 후에도 근거 부족 · 검증 보류"; break; }
                    message(run,incidentId,"verifier","detector","REQUEST_REFRESH","최신 관측 재조회 요청 · 최대 2회",attempt+1);
                    Instant previous=rows.stream().map(Observation::generatedAt).max(Comparator.naturalOrder()).orElse(Instant.EPOCH);
                    if(run.mode()==Mode.DEMO) {
                        Observation last=rows.stream().max(Comparator.comparing(Observation::generatedAt)).orElseThrow();
                        var fresh=new Observation("obs-"+UUID.randomUUID(),Mode.DEMO,station,direction,last.trainId(),last.position(),last.etaSeconds()+60,Instant.now(),Instant.now(),"합성 추가 관측","{}");
                        rows=new ArrayList<>(rows); rows.add(fresh); persist(List.of(fresh));
                    } else {
                        var refreshed=seoul.collect(List.of(station)); persist(refreshed);
                        rows=store.list("observation",scope,100,Observation.class);
                        if(rows.stream().noneMatch(o->o.generatedAt().isAfter(previous))) {
                            reason="재조회 응답에 더 최신인 관측이 없어 다음 수집까지 보류합니다."; break;
                        }
                    }
                }
            } catch(Exception e) {
                state="VERIFY_PENDING";
                reason=e instanceof java.net.http.HttpTimeoutException?"에이전트 응답 시간 초과 · 알림 보류":"에이전트 응답 또는 재조회 오류 · 알림 보류";
                message(run,incidentId,"verifier","server","VERIFICATION_FAILED",reason,0);
                if(scenario==Scenario.TIMEOUT || scenario==Scenario.INVALID_RESPONSE) {
                    var job=new AgentJob("job-"+UUID.randomUUID(),run.id(),"verifier",scenario==Scenario.TIMEOUT?"TIMED_OUT":"FAILED","simulation",reason,Instant.now(),Instant.now());
                    store.put(job.id(),"job",run.id(),job);
                }
            }
        } else if(continuing) {
            // Recovery requires three independently timestamped fresh samples showing movement / falling ETA.
            Observation newest=rows.stream().max(Comparator.comparing(Observation::generatedAt)).orElseThrow();
            List<Observation> normal=rows.stream().filter(o->o.trainId().equals(newest.trainId()) && o.generatedAt().isAfter(prior.createdAt()))
                    .sorted(Comparator.comparing(Observation::generatedAt)).toList();
            if(run.mode()==Mode.DEMO && scenario==Scenario.RECOVERY) normal=rows;
            var ordered=normal.stream().collect(java.util.stream.Collectors.toMap(Observation::generatedAt,o->o,(a,b)->a,TreeMap::new)).values().stream().toList();
            if(ordered.size()>3) ordered=ordered.subList(ordered.size()-3,ordered.size());
            boolean recovering=ordered.size()>=3 && Duration.between(ordered.getFirst().generatedAt(),ordered.getLast().generatedAt()).toSeconds()>=60
                    && ordered.get(2).etaSeconds()<ordered.get(1).etaSeconds() && ordered.get(1).etaSeconds()<ordered.get(0).etaSeconds()
                    && !ordered.getLast().position().equals(ordered.getFirst().position());
            state=recovering?"RECOVERED":"VERIFY_PENDING";
            reason=recovering?"최신 관측에서 위치 이동과 도착예정시간 감소를 확인했습니다. 공식 장애 복구 확정은 아닙니다.":"기존 사건의 관측 회복을 확인할 추가 데이터가 필요합니다.";
        }
        Incident incident=new Incident(incidentId,run.mode(),station,direction,state,reason,evidence,created,Instant.now());
        store.put(incident.id(),"incident",scope,incident);
        if(state.equals("DELAY_SUSPECTED") || state.equals("RECOVERED")) notifySubscribers(incident);
    }
    private AgentResult call(Run run,String incident,String role,String station,String direction,int attempt,boolean healthy,List<Observation> rows) throws Exception {
        String id="job-"+UUID.randomUUID(); Instant start=Instant.now();
        store.put(id,"job",run.id(),new AgentJob(id,run.id(),role,"RUNNING","pending","분석 중",start,null));
        try {
            AgentResult result=agents.call(new AgentRequest(id,role,run.mode(),station,direction,attempt,healthy,freshSeconds,rows,Instant.now()));
            for(ToolTrace tool:result.tools()) message(run,incident,role,"tool",tool.tool(),tool.detail(),attempt);
            message(run,incident,role,"server",result.verdict().name(),result.reason(),attempt);
            store.put(id,"job",run.id(),new AgentJob(id,run.id(),role,"SUCCEEDED",result.engine(),result.reason(),start,Instant.now()));
            return result;
        } catch(Exception e) {
            store.put(id,"job",run.id(),new AgentJob(id,run.id(),role,e instanceof java.net.http.HttpTimeoutException?"TIMED_OUT":"FAILED","unknown","응답 오류 · 알림 보류",start,Instant.now()));
            throw e;
        }
    }
    private void notifySubscribers(Incident i) {
        for(Subscription sub:store.list("subscription",null,1000,Subscription.class)) {
            if(!sub.station().equals(i.station()) || !sub.direction().equals(i.direction())) continue;
            String id="notice-"+UUID.nameUUIDFromBytes((sub.owner()+i.id()+i.state()).getBytes(StandardCharsets.UTF_8));
            String title=(i.mode()==Mode.DEMO?"[시연] ":"")+i.station()+" · "+i.direction()+" "+(i.state().equals("RECOVERED")?"관측 회복":"지연 의심");
            store.insert(id,"notice",sub.owner(),new Notice(id,sub.owner(),i.id(),i.mode(),i.station(),i.direction(),i.state(),title,i.summary(),Instant.now(),false));
        }
    }
    private void message(Run run,String incident,String sender,String recipient,String type,String detail,int attempt) {
        AgentMessage msg=new AgentMessage("msg-"+UUID.randomUUID(),run.id(),incident,sender,recipient,type,detail,attempt,Instant.now());
        store.insert(msg.id(),"message",run.id(),msg);
    }
    private void persist(List<Observation> rows) { rows.forEach(o->store.insert(o.id(),"observation",scope(o.mode(),o.station(),o.direction()),o)); }
    private void save(Run run) { store.put(run.id(),"run",run.mode().name(),run); }
    public static String scope(Mode mode,String station,String direction) { return mode+":"+station+":"+direction; }
    @PreDestroy public void close() { executor.shutdownNow(); }
}
