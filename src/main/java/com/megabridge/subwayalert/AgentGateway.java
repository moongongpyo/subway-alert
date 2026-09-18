package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.Models.*;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

@Component
public class AgentGateway {
    private final JsonMapper json;
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    @Value("${app.detector-url}") private String detectorUrl;
    @Value("${app.verifier-url}") private String verifierUrl;
    @Value("${app.detector-preview-token}") private String detectorPreview;
    @Value("${app.verifier-preview-token}") private String verifierPreview;
    @Value("${app.agent-token}") private String token;
    @Value("${app.agent-timeout-seconds}") private int timeout;
    public AgentGateway(JsonMapper json) { this.json=json; }
    public boolean configured() { return !detectorUrl.isBlank() && !verifierUrl.isBlank() && !token.isBlank(); }
    public RoutingService.Decision route(String role,TmapClient.RoutePlan plan,List<RouteRules.Block> blocks,RoutingService.Decision proposal,int attempt) throws Exception {
        Map<String,Object> body=new LinkedHashMap<>();
        body.put("requestId",UUID.randomUUID().toString()); body.put("role",role); body.put("plan",plan);
        body.put("blocks",blocks); body.put("proposal",proposal); body.put("attempt",attempt);
        String url=role.equals("detector")?detectorUrl:verifierUrl,preview=role.equals("detector")?detectorPreview:verifierPreview;
        var builder=HttpRequest.newBuilder(URI.create(url.replaceAll("/+$","")+"/route"))
                .timeout(Duration.ofSeconds(timeout)).header("Content-Type","application/json").header("Authorization","Bearer "+token);
        if(!preview.isBlank()) builder.header("x-daytona-preview-token",preview);
        var response=http.send(builder.POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());
        if(response.statusCode()!=200 || response.body().length()>100_000) throw new IllegalStateException("경로 에이전트 응답 오류");
        var result=json.readValue(response.body(),RoutingService.Decision.class);
        if(result==null || result.routeId()==null || result.reason()==null || result.reason().isBlank() || result.reason().length()>1200
                || result.tools()==null || result.tools().size()>12 || !Set.of("PROPOSE","APPROVED","REVISE","NO_ALTERNATIVE").contains(result.verdict())
                || !Set.of("openai","simulation").contains(result.engine())) throw new IllegalArgumentException("경로 에이전트 형식 오류");
        if(plan.provider().equals("TMAP") && !result.engine().equals("openai")) throw new IllegalArgumentException("실제 경로는 실제 AI 검증 필요");
        return result;
    }
    public AgentResult call(AgentRequest request) throws Exception {
        if(!configured()) {
            if(request.mode()==Mode.LIVE) throw new IllegalStateException("AI 에이전트 연결 설정이 필요합니다.");
            return simulate(request);
        }
        String url=request.role().equals("detector")?detectorUrl:verifierUrl;
        String preview=request.role().equals("detector")?detectorPreview:verifierPreview;
        HttpRequest.Builder builder=HttpRequest.newBuilder(URI.create(url.replaceAll("/+$","")+"/analyze"))
                .timeout(Duration.ofSeconds(timeout)).header("Content-Type","application/json")
                .header("Authorization","Bearer "+token);
        if(!preview.isBlank()) builder.header("x-daytona-preview-token",preview);
        HttpResponse<String> response=http.send(builder.POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(request))).build(),HttpResponse.BodyHandlers.ofString());
        if(response.statusCode()!=200) throw new IllegalStateException("에이전트 응답 오류 (HTTP "+response.statusCode()+")");
        if(response.body().length()>100_000) throw new IllegalStateException("에이전트 응답 크기 초과");
        AgentResult result=json.readValue(response.body(),AgentResult.class);
        validate(result,request);
        return result;
    }
    static void validate(AgentResult r,AgentRequest request) {
        if(r==null || r.verdict()==null || r.reason()==null || r.reason().isBlank() || r.reason().length()>1200
                || r.evidenceIds()==null || r.tools()==null || r.tools().size()>12 || r.engine()==null)
            throw new IllegalArgumentException("에이전트 결과 형식 오류");
        Set<String> ids=new HashSet<>(request.observations().stream().map(Observation::id).toList());
        if(!ids.containsAll(r.evidenceIds())) throw new IllegalArgumentException("존재하지 않는 근거 ID");
        if(request.mode()==Mode.LIVE && !r.engine().equals("openai")) throw new IllegalArgumentException("실시간 모드는 실제 AI 검증이 필요합니다.");
        if(r.verdict()==Verdict.ALERT_ALLOWED && (r.evidenceIds().isEmpty() || !request.collectionHealthy()))
            throw new IllegalArgumentException("알림 근거 부족");
    }
    static AgentResult simulate(AgentRequest r) {
        var a=EvidenceRules.assess(r.observations(),r.now(),r.freshSeconds());
        List<ToolTrace> traces=new ArrayList<>(List.of(new ToolTrace("read_observations","원본 관측 "+r.observations().size()+"개 확인"),new ToolTrace("check_freshness",a.reason())));
        Verdict verdict;
        if(!r.collectionHealthy() || !a.fresh()) verdict=Verdict.COLLECTION_ERROR;
        else if(!a.candidate()) verdict=Verdict.REJECTED;
        else if(r.role().equals("verifier") && r.attempt()==0) {
            verdict=Verdict.NEEDS_MORE_DATA;
            traces.add(new ToolTrace("request_refresh","추가 관측을 탐지 에이전트에 요청"));
        } else verdict=Verdict.ALERT_ALLOWED;
        return new AgentResult(verdict,a.reason(),a.evidenceIds(),traces,"simulation");
    }
}
