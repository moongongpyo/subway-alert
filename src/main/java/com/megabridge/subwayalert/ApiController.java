package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.Models.*;
import jakarta.servlet.http.*;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.time.Instant;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api")
public class ApiController {
    private final Store store;
    private final Coordinator coordinator;
    private final SeoulClient seoul;
    private final AgentGateway agents;
    private final TmapClient tmap;
    private final RoutingService routing;
    private final MetroNotices metroNotices;
    private final MockDisruptions mocks;
    @Value("${app.poll-ms}") private long pollMs;
    public ApiController(Store store,Coordinator coordinator,SeoulClient seoul,AgentGateway agents,TmapClient tmap,RoutingService routing,MetroNotices metroNotices,MockDisruptions mocks) {
        this.store=store; this.coordinator=coordinator; this.seoul=seoul; this.agents=agents; this.tmap=tmap; this.routing=routing; this.metroNotices=metroNotices; this.mocks=mocks;
    }
    @GetMapping("/dashboard")
    public Map<String,Object> dashboard(HttpServletRequest request,HttpServletResponse response) {
        String owner=owner(request,response);
        List<Map<String,Object>> routes=new ArrayList<>();
        for(String station:STATIONS) for(String direction:DIRECTIONS) {
            String scope=Coordinator.scope(coordinator.mode(),station,direction);
            var observations=store.list("observation",scope,12,Observation.class).stream()
                    .sorted(Comparator.comparing(Observation::generatedAt).reversed()).map(o->Map.of(
                            "id",o.id(),"trainId",o.trainId(),"position",o.position(),"etaSeconds",o.etaSeconds(),
                            "generatedAt",o.generatedAt(),"collectedAt",o.collectedAt(),"source",o.source())).toList();
            Map<String,Object> route=new LinkedHashMap<>();
            route.put("station",station); route.put("direction",direction); route.put("observations",observations);
            route.put("incident",store.list("incident",scope,1,Incident.class).stream().findFirst().orElse(null));
            routes.add(route);
        }
        var runs=store.list("run",coordinator.mode().name(),15,Run.class);
        Set<String> runIds=new HashSet<>(runs.stream().map(Run::id).toList());
        return Map.of("mode",coordinator.mode(),"busy",coordinator.busy(),"routes",routes,
                "runs",runs,"messages",store.list("message",null,120,AgentMessage.class).stream().filter(m->runIds.contains(m.runId())).toList(),
                "jobs",store.list("job",null,40,AgentJob.class).stream().filter(j->runIds.contains(j.runId())).toList(),
                "subscriptions",store.list("subscription",owner,6,Subscription.class),
                "notifications",store.list("notice",owner,50,Notice.class),"settings",Map.of(
                        "seoulConfigured",seoul.configured(),"agentsConfigured",agents.configured(),"callsToday",store.callsToday(),
                        "dailyBudget",seoul.budget(),"pollIntervalMs",pollMs,"freshSeconds",coordinator.freshness(),
                        "seoulNoticeConfigured",metroNotices.configured(),"tmapConfigured",tmap.configured(),
                        "tmapCallsToday",tmap.callsToday()),"serverTime",Instant.now());
    }
    public record RouteQuery(@NotNull TmapClient.Place from,@NotNull TmapClient.Place to,@NotBlank String provider,Boolean simulation,String searchDttm) {}
    @PostMapping("/routes")
    public RoutingService.Snapshot routes(@Valid @RequestBody RouteQuery body,HttpServletRequest request,HttpServletResponse response) {
        mutation(request); return routing.create(owner(request,response),body.from(),body.to(),body.provider(),Boolean.TRUE.equals(body.simulation()),body.searchDttm());
    }
    @GetMapping("/routes/{id}")
    public RoutingService.Snapshot route(@PathVariable String id,HttpServletRequest request,HttpServletResponse response) { return routing.get(owner(request,response),id); }
    public record Avoid(@NotBlank String legId,@NotBlank String scope,@NotBlank String reason) {}
    @PostMapping("/routes/{id}/avoid")
    public RoutingService.Snapshot avoid(@PathVariable String id,@Valid @RequestBody Avoid body,HttpServletRequest request,HttpServletResponse response) {
        mutation(request); return routing.avoid(owner(request,response),id,body.legId(),body.scope(),body.reason());
    }
    @DeleteMapping("/routes/{id}/avoid/{blockId}")
    public RoutingService.Snapshot removeAvoid(@PathVariable String id,@PathVariable String blockId,HttpServletRequest request,HttpServletResponse response) {
        mutation(request); return routing.remove(owner(request,response),id,blockId);
    }
    @GetMapping("/mock-disruptions") public Object mockList(){return mocks.list();}
    public record MockBody(@NotBlank String sessionId,@NotBlank String legId,int startIndex,int endIndex,@NotNull Instant startsAt,@NotNull Instant endsAt) {}
    @PostMapping("/mock-disruptions") public Object mockCreate(@Valid @RequestBody MockBody body,HttpServletRequest request,HttpServletResponse response){
        mutation(request);var leg=routing.mockLeg(owner(request,response),body.sessionId(),body.legId(),body.startIndex(),body.endIndex());return mocks.create(leg,body.startsAt(),body.endsAt());
    }
    @DeleteMapping("/mock-disruptions/{id}") public Object mockDelete(@PathVariable String id,HttpServletRequest request){mutation(request);mocks.delete(id);return Map.of("ok",true);}
    public record Subscribe(@NotBlank String station,@NotBlank String direction) {}
    @PostMapping("/subscriptions")
    public Subscription subscribe(@Valid @RequestBody Subscribe body,HttpServletRequest request,HttpServletResponse response) {
        mutation(request);
        if(!STATIONS.contains(body.station()) || !DIRECTIONS.contains(body.direction())) throw new IllegalArgumentException("지원하지 않는 역 또는 방향입니다.");
        String owner=owner(request,response);
        String id="sub-"+UUID.nameUUIDFromBytes((owner+body.station()+body.direction()).getBytes(StandardCharsets.UTF_8));
        Subscription subscription=new Subscription(id,owner,body.station(),body.direction(),Instant.now());
        store.insert(id,"subscription",owner,subscription);
        return store.get(id,"subscription",Subscription.class).orElseThrow();
    }
    @DeleteMapping("/subscriptions/{id}")
    public Map<String,Boolean> unsubscribe(@PathVariable String id,HttpServletRequest request,HttpServletResponse response) {
        mutation(request); store.delete(id,"subscription",owner(request,response)); return Map.of("ok",true);
    }
    @PatchMapping("/notifications/{id}/read")
    public Map<String,Boolean> read(@PathVariable String id,HttpServletRequest request,HttpServletResponse response) {
        mutation(request); String owner=owner(request,response);
        Notice n=store.get(id,"notice",Notice.class).filter(v->v.owner().equals(owner)).orElseThrow(()->new ResponseStatusException(HttpStatus.NOT_FOUND));
        store.put(n.id(),"notice",owner,new Notice(n.id(),n.owner(),n.incidentId(),n.mode(),n.station(),n.direction(),n.phase(),n.title(),n.body(),n.createdAt(),true));
        return Map.of("ok",true);
    }
    public record ScenarioBody(@NotNull Scenario scenario,@NotBlank String station,@NotBlank String direction,@NotBlank String requestId) {}
    @PostMapping("/admin/scenarios")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Run scenario(@Valid @RequestBody ScenarioBody body,HttpServletRequest request) {
        mutation(request); return coordinator.start(body.scenario(),body.station(),body.direction(),body.requestId());
    }
    public record ModeBody(@NotNull Mode mode) {}
    @PostMapping("/admin/mode")
    public Map<String,Mode> mode(@Valid @RequestBody ModeBody body,HttpServletRequest request) {
        mutation(request); coordinator.setMode(body.mode()); return Map.of("mode",coordinator.mode());
    }
    @PostMapping("/admin/collect")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Run collect(HttpServletRequest request) {
        mutation(request);
        if(coordinator.mode()!=Mode.LIVE) throw new IllegalArgumentException("실시간 모드에서만 수집할 수 있습니다.");
        return coordinator.start(null,null,null,UUID.randomUUID().toString());
    }
    private static void mutation(HttpServletRequest request) {
        if(!"SubwayAlert".equals(request.getHeader("X-Requested-With"))) throw new ResponseStatusException(HttpStatus.FORBIDDEN,"요청 헤더가 필요합니다.");
    }
    private static String owner(HttpServletRequest request,HttpServletResponse response) {
        String token=null;
        if(request.getCookies()!=null) for(Cookie c:request.getCookies()) if(c.getName().equals("subway_session")&&c.getValue().matches("[a-f0-9]{64}")) token=c.getValue();
        if(token==null) {
            byte[] bytes=new byte[32]; new SecureRandom().nextBytes(bytes); token=HexFormat.of().formatHex(bytes);
            boolean secure=request.isSecure() || "https".equalsIgnoreCase(request.getHeader("X-Forwarded-Proto"));
            response.addHeader("Set-Cookie",ResponseCookie.from("subway_session",token).httpOnly(true).secure(secure).sameSite("Lax").path("/").maxAge(30L*86400).build().toString());
        }
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8))); }
        catch(NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    @ExceptionHandler(IllegalArgumentException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public Map<String,String> invalid(IllegalArgumentException e) { return Map.of("message",e.getMessage()==null?"입력값을 확인하세요.":e.getMessage()); }
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<Map<String,String>> statusError(ResponseStatusException e) {
        return ResponseEntity.status(e.getStatusCode()).body(Map.of("message",e.getReason()==null?"요청을 처리할 수 없습니다.":e.getReason()));
    }
    @ExceptionHandler(IllegalStateException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String,String> conflict(IllegalStateException e) { return Map.of("message",e.getMessage()==null?"요청을 처리할 수 없습니다.":e.getMessage()); }
}
