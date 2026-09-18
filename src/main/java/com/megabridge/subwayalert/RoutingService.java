package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.TmapClient.*;
import static com.megabridge.subwayalert.RouteRules.*;
import jakarta.annotation.PreDestroy;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class RoutingService {
    public record Decision(String verdict,String routeId,String reason,List<Models.ToolTrace> tools,String engine) {}
    public record Trace(String role,String verdict,String routeId,String reason,List<Models.ToolTrace> tools,String engine) {}
    public record Snapshot(String id,RoutePlan plan,Instant expiresAt,List<Block> blocks,List<Assessment> assessments,
                           String recommendedId,String state,String message,List<Trace> traces,boolean busy) {}
    private static final class Session {
        final String id=UUID.randomUUID().toString(),owner;
        final RoutePlan plan;
        boolean simulation;
        final List<Block> blocks=new ArrayList<>();
        final List<Trace> traces=new ArrayList<>();
        List<Assessment> assessments=List.of();
        String recommended="",state="READY",message="";
        volatile boolean busy;
        Session(String owner,RoutePlan plan) { this.owner=owner; this.plan=plan; }
        synchronized Snapshot snapshot() { return new Snapshot(id,plan,plan.fetchedAt().plusSeconds(300),List.copyOf(blocks),assessments,recommended,state,message,List.copyOf(traces),busy); }
    }
    private final TmapClient tmap;
    private final AgentGateway agents;
    private final MockDisruptions mocks;
    private final Map<String,Session> sessions=new ConcurrentHashMap<>();
    private final ThreadPoolExecutor executor=new ThreadPoolExecutor(2,2,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(8));
    public RoutingService(TmapClient tmap,AgentGateway agents,MockDisruptions mocks) { this.tmap=tmap; this.agents=agents; this.mocks=mocks; }
    @PreDestroy void close() { executor.shutdownNow(); }
    public Snapshot create(String owner,Place from,Place to,String provider) { return create(owner,from,to,provider,false); }
    public synchronized Snapshot create(String owner,Place from,Place to,String provider,boolean simulation) {
        sessions.values().removeIf(s->!s.plan.fetchedAt().plusSeconds(300).isAfter(Instant.now()) && !s.busy);
        if(sessions.size()>=200) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"잠시 후 다시 검색하세요.");
        if(from==null || to==null || (from.lon()==to.lon() && from.lat()==to.lat())) throw new IllegalArgumentException("서로 다른 출발지와 도착지를 선택하세요.");
        if(!Set.of("DEMO","TMAP").contains(provider)) throw new IllegalArgumentException("경로 데이터 종류를 선택하세요.");
        long owned=sessions.values().stream().filter(s->s.owner.equals(owner)).count();
        if(owned>=10) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"검색은 5분에 10회까지 가능합니다.");
        var session=new Session(owner,provider.equals("DEMO")?RouteDemo.create(from,to):tmap.routes(from,to));
        session.simulation=simulation; sessions.put(session.id,session); syncMocks(session); evaluate(session); return session.snapshot();
    }
    public Snapshot get(String owner,String id) { Session s=find(owner,id); synchronized(s) {if(!s.busy && syncMocks(s))evaluate(s);return s.snapshot();} }
    private boolean syncMocks(Session s) {
        if(!s.simulation)return false;
        var active=mocks.blocks(Instant.now());
        var previous=s.blocks.stream().filter(b->b.source().equals("MOCK")).map(Block::id).collect(java.util.stream.Collectors.toSet());
        var next=active.stream().map(Block::id).collect(java.util.stream.Collectors.toSet());
        if(previous.equals(next))return false;
        s.blocks.removeIf(b->b.source().equals("MOCK"));s.blocks.addAll(active);return true;
    }
    public Leg mockLeg(String owner,String id,String legId,int start,int end) {
        var s=find(owner,id);var leg=s.plan.journeys().stream().flatMap(j->j.legs().stream()).filter(l->l.id().equals(legId)).findFirst().orElseThrow(()->new IllegalArgumentException("경로 구간을 다시 선택하세요."));
        if(!completeStops(leg)||start<0||end>=leg.stops().size()||start>=end)throw new IllegalArgumentException("시작·종료 정류장을 순서대로 선택하세요.");
        var stops=List.copyOf(leg.stops().subList(start,end+1));
        return new Leg(leg.id(),leg.mode(),leg.route(),leg.routeId(),leg.type(),stops.getFirst().name(),stops.getLast().name(),leg.durationSeconds(),leg.service(),stops);
    }
    public Snapshot avoid(String owner,String id,String legId,String scope,String reason) {
        Session s=find(owner,id);
        synchronized(s) {
            available(s);
            if(!Set.of("SEGMENT","LINE").contains(scope) || !Set.of("이용 불가","운행 중단","지연 우려","공사·통제","개인 선택").contains(reason)) throw new IllegalArgumentException("회피 범위와 사유를 선택하세요.");
            Leg leg=s.plan.journeys().stream().flatMap(j->j.legs().stream()).filter(l->l.id().equals(legId)).findFirst().orElseThrow(()->new IllegalArgumentException("존재하지 않는 구간입니다."));
            if(!Set.of("SUBWAY","BUS").contains(leg.mode())) throw new IllegalArgumentException("버스·지하철 구간만 지정할 수 있습니다.");
            if(s.blocks.stream().anyMatch(b->b.leg().id().equals(legId) && b.scope().equals(scope))) return s.snapshot();
            if(s.blocks.size()>=12) throw new IllegalArgumentException("한 경로 검색에서 회피 조건은 최대 12개입니다.");
            s.blocks.add(new Block(UUID.randomUUID().toString(),scope,reason,s.plan.provider().equals("DEMO")?"DEMO":"USER_CONSTRAINT",leg,Instant.now()));
            evaluate(s); return s.snapshot();
        }
    }
    public Snapshot remove(String owner,String id,String blockId) {
        Session s=find(owner,id);
        synchronized(s) { available(s); s.blocks.removeIf(b->b.id().equals(blockId)&&!b.source().equals("MOCK")); evaluate(s); return s.snapshot(); }
    }
    private Session find(String owner,String id) {
        Session s=sessions.get(id);
        if(s==null || !s.owner.equals(owner)) throw new ResponseStatusException(HttpStatus.NOT_FOUND,"경로 검색을 찾을 수 없습니다.");
        if(!s.plan.fetchedAt().plusSeconds(300).isAfter(Instant.now())) throw new ResponseStatusException(HttpStatus.GONE,"경로 정보가 만료됐습니다. 출발·도착지를 다시 검색하세요.");
        return s;
    }
    private void available(Session s) { if(s.busy) throw new ResponseStatusException(HttpStatus.CONFLICT,"에이전트 검증이 끝난 뒤 변경하세요."); }
    private void evaluate(Session s) {
        synchronized(s) {
            s.assessments=assess(s.plan,List.copyOf(s.blocks)); s.traces.clear(); s.recommended="";
            String best=best(s.plan,s.assessments);
            if(!agents.configured()) {
                s.recommended=best;
                s.state=best.isEmpty()?"NO_ALTERNATIVE":"RULE_CHECKED";
                s.message=best.isEmpty()?"반환된 후보에서 조건을 만족하는 대안을 찾지 못했습니다. 출발·도착 지점을 바꾸거나 다른 이동수단을 확인하세요.":"구간 회피 규칙 검사 완료 · AI 연결 전입니다.";
                return;
            }
            s.busy=true; s.state="ANALYZING"; s.message="경로 에이전트 A가 후보를 비교하고 B가 회피 구간을 다시 검사합니다.";
            try { executor.execute(()->collaborate(s)); }
            catch(RejectedExecutionException e) { s.busy=false; s.state="VERIFY_PENDING"; s.message="검증 요청이 많습니다. 잠시 후 다시 검색하세요."; }
        }
    }
    private void collaborate(Session s) {
        try {
            Decision proposal=null,verification=null;
            for(int attempt=0;attempt<2;attempt++) {
                proposal=agents.route("detector",s.plan,List.copyOf(s.blocks),proposal,attempt);
                synchronized(s) { s.traces.add(trace("planner",proposal)); }
                verification=agents.route("verifier",s.plan,List.copyOf(s.blocks),proposal,attempt);
                synchronized(s) { s.traces.add(trace("verifier",verification)); }
                if(!verification.verdict().equals("REVISE")) break;
                proposal=verification;
            }
            synchronized(s) {
                String best=best(s.plan,s.assessments);
                if(!s.plan.fetchedAt().plusSeconds(300).isAfter(Instant.now())) throw new IllegalStateException("expired");
                if(best.isEmpty() && verification.verdict().equals("NO_ALTERNATIVE")) {
                    s.state="NO_ALTERNATIVE"; s.message="두 에이전트가 반환된 후보에서 회피 가능한 대안을 찾지 못했습니다.";
                } else if(verification.verdict().equals("APPROVED") && proposal.routeId().equals(verification.routeId())
                        && verification.routeId().equals(best)) {
                    s.recommended=best; s.state="VERIFIED"; s.message="두 에이전트와 서버가 지정된 구간 회피를 확인했습니다. 실제 운행 여부는 탑승 전 확인하세요.";
                } else throw new IllegalStateException("unverified");
            }
        } catch(Exception e) {
            synchronized(s) { s.recommended=""; s.state="VERIFY_PENDING"; s.message="AI 검증을 완료하지 못했습니다. 후보 경로만 표시하며 추천을 보류합니다."; }
        } finally { synchronized(s) { s.busy=false; } }
    }
    static String best(RoutePlan plan,List<Assessment> assessments) {
        Set<String> eligible=new HashSet<>(assessments.stream().filter(Assessment::eligible).map(Assessment::routeId).toList());
        return plan.journeys().stream().filter(j->eligible.contains(j.id())).min(Comparator.comparingInt(Journey::totalSeconds).thenComparingInt(Journey::transfers).thenComparingInt(Journey::walkSeconds).thenComparing(Journey::id)).map(Journey::id).orElse("");
    }
    private static Trace trace(String role,Decision d) { return new Trace(role,d.verdict(),d.routeId(),d.reason(),d.tools(),d.engine()); }
}
