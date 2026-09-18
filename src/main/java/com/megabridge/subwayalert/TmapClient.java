package com.megabridge.subwayalert;

import java.net.URI;
import java.net.http.*;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@Component
public class TmapClient {
    public record Place(String name,double lon,double lat) {
        public Place {
            if(name==null || name.isBlank() || name.length()>80 || !Double.isFinite(lon) || !Double.isFinite(lat)
                    || lon<124 || lon>132 || lat<33 || lat>39) throw new IllegalArgumentException("국내 출발·도착지 이름과 올바른 경도·위도가 필요합니다.");
        }
    }
    public static final Map<String,Place> PLACES=Map.of(
            "강남",new Place("강남",127.027619,37.497952),"역삼",new Place("역삼",127.036456,37.500622),"선릉",new Place("선릉",127.048203,37.504286));
    public record Stop(String id,String name) {}
    public record Leg(String id,String mode,String route,String routeId,int type,String start,String end,
                      int durationSeconds,String service,List<Stop> stops) {}
    public record Journey(String id,int totalSeconds,Integer totalFare,int transfers,int walkSeconds,int distanceMeters,List<Leg> legs) {}
    public record RoutePlan(String provider,Place from,Place to,Instant fetchedAt,boolean cached,List<Journey> journeys,String note) {}
    private static final String NOTE="TMAP 예상 소요시간입니다. 장애 정보는 별도로 적용하며 실제 운행·안전을 보장하지 않습니다.";
    private final Store store;
    private final JsonMapper json;
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    private final Map<String,RoutePlan> cache=new LinkedHashMap<>();
    @Value("${app.tmap-key}") private String key;
    @Value("${app.tmap-url}") private String endpoint;
    public TmapClient(Store store,JsonMapper json) { this.store=store; this.json=json; }
    public boolean configured() { return !key.isBlank(); }
    public int callsToday() { return store.providerCallsToday("TMAP"); }
    public RoutePlan routes(Place from,Place to) { return routes(from,to,null); }
    static String validateDeparture(String value) {
        if(value==null||value.isBlank())return "";
        try {
            if(!value.matches("[0-9]{12}"))throw new IllegalArgumentException();
            var dt=LocalDateTime.parse(value,java.time.format.DateTimeFormatter.ofPattern("uuuuMMddHHmm").withResolverStyle(java.time.format.ResolverStyle.STRICT));
            if(dt.getYear()<1900)throw new IllegalArgumentException();
            return value;
        }catch(RuntimeException e){throw new IllegalArgumentException("출발 시간을 한국 시간 기준의 올바른 날짜와 시각으로 설정하세요.");}
    }
    public synchronized RoutePlan routes(Place from,Place to,String departure) {
        String searchDttm=validateDeparture(departure);
        if(from==null || to==null || (from.lon()==to.lon() && from.lat()==to.lat())) throw new IllegalArgumentException("서로 다른 출발지와 도착지를 선택하세요.");
        if(!configured()) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"TMAP_APP_KEY 설정이 필요합니다.");
        Instant now=Instant.now();
        cache.entrySet().removeIf(entry->!entry.getValue().fetchedAt().plusSeconds(300).isAfter(now));
        String cacheKey=from.toString()+":"+to.toString()+":"+searchDttm;
        RoutePlan saved=cache.get(cacheKey);
        if(saved!=null) return new RoutePlan(saved.provider(),from,to,saved.fetchedAt(),true,saved.journeys(),NOTE);
        store.recordProviderCall("TMAP");
        Map<String,Object> body=new LinkedHashMap<>(Map.of("startX",String.valueOf(from.lon()),"startY",String.valueOf(from.lat()),"endX",String.valueOf(to.lon()),"endY",String.valueOf(to.lat()),"count",10,"lang",0,"format","json"));
        if(!searchDttm.isEmpty())body.put("searchDttm",searchDttm);
        try {
            var request=HttpRequest.newBuilder(URI.create(endpoint)).timeout(Duration.ofSeconds(12))
                    .header("appKey",key).header("accept","application/json").header("content-type","application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build();
            var response=http.send(request,HttpResponse.BodyHandlers.ofInputStream());
            byte[] bytes;
            try(var stream=response.body()) { bytes=stream.readNBytes(3_000_001); }
            if(response.statusCode()==429) throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"TMAP 제공 한도를 초과했습니다. 앱 자체 제한이 아닌 TMAP 응답(429)입니다. SK Open API 콘솔에서 이용량·상품 한도·갱신 시각을 확인하세요.");
            if(response.statusCode()==401 || response.statusCode()==403) throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"TMAP 인증 또는 상품 접근이 거부됐습니다. SK Open API에서 앱 키와 대중교통 상품 이용권한을 확인하세요.");
            if(response.statusCode()!=200 || bytes.length>3_000_000) throw new IllegalStateException();
            var result=parse(json.readTree(bytes),from,to,Instant.now());
            if(cache.size()>=100) cache.remove(cache.keySet().iterator().next());
            cache.put(cacheKey,result);
            return result;
        } catch(InterruptedException e) {
            Thread.currentThread().interrupt(); throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"TMAP 경로 조회가 중단되었습니다.");
        } catch(ResponseStatusException e) {
            throw e;
        } catch(Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"TMAP 경로 조회 실패 · 인증키/상품 이용권한/응답 상태를 확인하세요.");
        }
    }
    static RoutePlan parse(JsonNode root,Place from,Place to,Instant now) {
        JsonNode values=root.path("metaData").path("plan").path("itineraries");
        if(!values.isArray()) {
            if(Set.of("11","12","13","14").contains(root.path("result").path("status").asText()))
                return new RoutePlan("TMAP",from,to,now,false,List.of(),"TMAP이 이 구간의 경로를 반환하지 않았습니다.");
            throw new IllegalArgumentException("경로 응답 없음");
        }
        List<Journey> journeys=new ArrayList<>();
        for(JsonNode value:values) {
            if(journeys.size()>=10) break;
            if(!value.path("totalTime").isNumber() || value.path("totalTime").asInt()<0 || !value.path("legs").isArray()) throw new IllegalArgumentException("잘못된 경로 응답");
            String id="route-"+(journeys.size()+1);
            List<Leg> legs=new ArrayList<>();
            for(JsonNode leg:value.path("legs")) {
                if(legs.size()>=30) throw new IllegalArgumentException("경로 구간 초과");
                String mode=leg.path("mode").asText();
                if(!Set.of("WALK","BUS","SUBWAY","EXPRESSBUS","TRAIN","AIRPLANE","FERRY").contains(mode)) mode="OTHER";
                String service=leg.has("service")?(leg.path("service").asInt()==1?"SCHEDULED":"NOT_SCHEDULED"):"UNKNOWN";
                List<Stop> stops=new ArrayList<>();
                JsonNode stopList=leg.path("passStopList").path("stationList");
                if(!stopList.isArray()) stopList=leg.path("passStopList").path("stations");
                if(stopList.isArray()) for(JsonNode stop:stopList) {
                    if(stops.size()>=300) throw new IllegalArgumentException("정류장 개수 초과");
                    stops.add(new Stop(limited(stop.path("stationID").asText()),limited(stop.path("stationName").asText())));
                }
                legs.add(new Leg(id+"-leg-"+legs.size(),mode,limited(leg.path("route").asText()),limited(leg.path("routeId").asText()),leg.path("type").asInt(-1),
                        limited(leg.path("start").path("name").asText()),limited(leg.path("end").path("name").asText()),Math.max(0,leg.path("sectionTime").asInt()),service,List.copyOf(stops)));
            }
            if(legs.isEmpty()) throw new IllegalArgumentException("빈 경로 구간");
            JsonNode fare=value.path("fare").path("regular").path("totalFare");
            journeys.add(new Journey(id,value.path("totalTime").asInt(),fare.isNumber()?Math.max(0,fare.asInt()):null,
                    Math.max(0,value.path("transferCount").asInt()),Math.max(0,value.path("totalWalkTime").asInt()),Math.max(0,value.path("totalDistance").asInt()),List.copyOf(legs)));
        }
        return new RoutePlan("TMAP",from,to,now,false,List.copyOf(journeys),NOTE);
    }
    private static String limited(String text) { return text.length()>200?text.substring(0,200):text; }
}
