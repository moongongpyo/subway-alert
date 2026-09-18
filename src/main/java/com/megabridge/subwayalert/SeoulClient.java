package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.Models.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Component
public class SeoulClient {
    private final Store store;
    private final JsonMapper json;
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(8)).build();
    @Value("${app.seoul-key}") private String key;
    @Value("${app.seoul-base-url}") private String base;
    @Value("${app.seoul-daily-budget}") private int budget;
    public SeoulClient(Store store,JsonMapper json) { this.store=store; this.json=json; }
    public boolean configured() { return !key.isBlank(); }
    public int budget() { return budget; }
    private JsonNode fetch(String service,String target) throws Exception {
        if(!configured()) throw new IllegalStateException("서울시 인증키가 필요합니다.");
        if(!store.reserveCalls(1,budget)) throw new IllegalStateException("오늘의 API 호출 예산을 사용했습니다.");
        String url=base.replaceAll("/+$","")+"/"+URLEncoder.encode(key,StandardCharsets.UTF_8)
                +"/json/"+service+"/0/1000/"+URLEncoder.encode(target,StandardCharsets.UTF_8);
        try {
            var response=http.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(12)).GET().build(),HttpResponse.BodyHandlers.ofString());
            if(response.statusCode()!=200 || response.body().length()>5_000_000) throw new IllegalStateException();
            return json.readTree(response.body());
        } catch(Exception e) {
            // Never propagate a request URI: it contains the Seoul credential.
            throw new IllegalStateException("서울시 API 연결 또는 응답 형식 오류");
        }
    }
    public List<Observation> collect(List<String> stations) throws Exception {
        JsonNode positions=fetch("realtimePosition","2호선").path("realtimePositionList");
        if(!positions.isArray() || positions.isEmpty()) throw new IllegalStateException("열차 위치정보가 없습니다.");
        Map<String,JsonNode> trains=new HashMap<>();
        positions.forEach(p -> {
            if(p.path("subwayId").asText().equals("1002")) trains.put(normalizeTrain(p.path("trainNo").asText()),p);
        });
        List<Observation> result=new ArrayList<>();
        for(String station:stations) {
            JsonNode arrivals=fetch("realtimeStationArrival",station).path("realtimeArrivalList");
            if(!arrivals.isArray()) throw new IllegalStateException(station+" 도착정보를 확인할 수 없습니다.");
            for(JsonNode a:arrivals) {
                if(!a.path("subwayId").asText().equals("1002")) continue;
                String direction=a.path("updnLine").asText();
                if(!DIRECTIONS.contains(direction)) continue;
                String train=normalizeTrain(a.path("btrainNo").asText());
                JsonNode p=trains.get(train);
                if(p==null || train.isBlank()) continue;
                String pd=p.path("updnLine").asText();
                // Seoul position API: 0 = up/inner, 1 = down/outer.
                if(!(pd.equals(direction) || pd.equals(direction.equals("내선")?"0":"1"))) continue;
                try {
                    Instant arrivalTime=parseTime(a.path("recptnDt").asText());
                    Instant positionTime=parseTime(p.path("recptnDt").asText());
                    if(Math.abs(Duration.between(arrivalTime,positionTime).toSeconds())>180) continue;
                    Instant generated=arrivalTime.isBefore(positionTime)?arrivalTime:positionTime;
                    int eta=Integer.parseInt(a.path("barvlDt").asText());
                    if(eta<0 || eta>7200 || p.path("statnNm").asText().isBlank()) continue;
                    String trainKey=generated.atZone(ZoneId.of("Asia/Seoul")).toLocalDate()+":1002:"+direction+":"+train;
                    String id="obs-"+UUID.nameUUIDFromBytes((station+trainKey+generated).getBytes(StandardCharsets.UTF_8));
                    result.add(new Observation(id,Mode.LIVE,station,direction,trainKey,p.path("statnNm").asText(),eta,generated,Instant.now(),
                            "서울시 위치·도착 API",json.writeValueAsString(Map.of("arrival",a,"position",p))));
                } catch(RuntimeException ignored) { /* malformed rows cannot become evidence */ }
            }
        }
        if(result.isEmpty()) throw new IllegalStateException("매칭 가능한 최신 위치·도착 관측이 없습니다.");
        return result;
    }
    static String normalizeTrain(String value) { return value.replaceFirst("^0+(?!$)",""); }
    static Instant parseTime(String value) {
        try { return Instant.parse(value); }
        catch(RuntimeException ignored) { return LocalDateTime.parse(value.replace('T',' '),DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")).atZone(ZoneId.of("Asia/Seoul")).toInstant(); }
    }
}
