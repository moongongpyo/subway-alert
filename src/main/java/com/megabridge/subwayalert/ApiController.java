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
    @Value("${app.admin-token}") private String adminToken;
    @Value("${app.poll-ms}") private long pollMs;
    public ApiController(Store store,Coordinator coordinator,SeoulClient seoul,AgentGateway agents) {
        this.store=store; this.coordinator=coordinator; this.seoul=seoul; this.agents=agents;
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
                        "adminTokenRequired",!adminToken.isBlank()),"serverTime",Instant.now());
    }
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
        admin(request); return coordinator.start(body.scenario(),body.station(),body.direction(),body.requestId());
    }
    public record ModeBody(@NotNull Mode mode) {}
    @PostMapping("/admin/mode")
    public Map<String,Mode> mode(@Valid @RequestBody ModeBody body,HttpServletRequest request) {
        admin(request); coordinator.setMode(body.mode()); return Map.of("mode",coordinator.mode());
    }
    @PostMapping("/admin/collect")
    @ResponseStatus(HttpStatus.ACCEPTED)
    public Run collect(HttpServletRequest request) {
        admin(request);
        if(coordinator.mode()!=Mode.LIVE) throw new IllegalArgumentException("실시간 모드에서만 수집할 수 있습니다.");
        return coordinator.start(null,null,null,UUID.randomUUID().toString());
    }
    private static void mutation(HttpServletRequest request) {
        if(!"SubwayAlert".equals(request.getHeader("X-Requested-With"))) throw new ResponseStatusException(HttpStatus.FORBIDDEN,"요청 헤더가 필요합니다.");
    }
    private void admin(HttpServletRequest request) {
        mutation(request);
        String supplied=Optional.ofNullable(request.getHeader("X-Admin-Token")).orElse("");
        if(!adminToken.isBlank()) {
            if(!MessageDigest.isEqual(adminToken.getBytes(StandardCharsets.UTF_8),supplied.getBytes(StandardCharsets.UTF_8))) throw new ResponseStatusException(HttpStatus.UNAUTHORIZED,"관리자 토큰을 확인하세요.");
        } else if(!Set.of("127.0.0.1","::1","0:0:0:0:0:0:0:1").contains(request.getRemoteAddr())
                || request.getHeader("Forwarded")!=null || request.getHeader("X-Forwarded-For")!=null) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,"외부 접속에는 APP_ADMIN_TOKEN 설정이 필요합니다.");
        }
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
    @ExceptionHandler(IllegalStateException.class)
    @ResponseStatus(HttpStatus.CONFLICT)
    public Map<String,String> conflict(IllegalStateException e) { return Map.of("message",e.getMessage()==null?"요청을 처리할 수 없습니다.":e.getMessage()); }
}
