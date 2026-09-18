package com.megabridge.subwayalert;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@RestController
public class PlaceSearch {
 public record Place(String id,String name,String address,double lon,double lat) {}
 private record Cached(Instant at,List<Place> places) {}
 private final Map<String,Cached> cache=new LinkedHashMap<>();
 private final JsonMapper json;private final Store store;
 private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
 @Value("${app.tmap-key}") private String key;
 @Value("${app.poi-url:https://apis.openapi.sk.com/tmap/pois}") private String endpoint;
 @Value("${app.poi-budget:500}") private int budget=500;
 public PlaceSearch(JsonMapper json,Store store){this.json=json;this.store=store;}
 @GetMapping("/api/places") public synchronized List<Place> search(@RequestParam String q) {
  q=q.trim();if(q.length()<2||q.length()>80)throw new ResponseStatusException(HttpStatus.BAD_REQUEST,"장소 이름을 2~80자로 입력해 주세요.");
  var saved=cache.get(q);if(saved!=null&&saved.at.plusSeconds(3600).isAfter(Instant.now()))return saved.places;
  if(key.isBlank())throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE,"장소 검색 연결이 필요합니다.");
  if(!store.reserveProviderCalls("TMAP_POI",1,budget))throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,"오늘의 장소 검색 한도를 사용했습니다.");
  try{
   var request=HttpRequest.newBuilder(URI.create(endpoint+"?version=1&count=8&resCoordType=WGS84GEO&format=json&searchKeyword="+URLEncoder.encode(q,StandardCharsets.UTF_8))).timeout(Duration.ofSeconds(12)).header("appKey",key).GET().build();
   var response=http.send(request,HttpResponse.BodyHandlers.ofInputStream());
   try(var body=response.body()){
    byte[] bytes=body.readNBytes(2_000_001);if(response.statusCode()!=200||bytes.length>2_000_000)throw new IllegalStateException();
    var places=parse(json.readTree(bytes));if(cache.size()>=300)cache.remove(cache.keySet().iterator().next());cache.put(q,new Cached(Instant.now(),places));return places;
   }
  }catch(Exception e){throw new ResponseStatusException(HttpStatus.BAD_GATEWAY,"장소를 검색하지 못했습니다. 잠시 후 다시 시도해 주세요.");}
 }
 static List<Place> parse(JsonNode root){
  var info=root.path("searchPoiInfo");if(!info.isObject())throw new IllegalArgumentException();
  var rows=info.path("pois").path("poi");if(!rows.isArray()){if(info.path("totalCount").asInt(-1)==0)return List.of();throw new IllegalArgumentException();}
  List<Place> result=new ArrayList<>();
  for(var row:rows){try{double lon=Double.parseDouble(row.path("frontLon").asText()),lat=Double.parseDouble(row.path("frontLat").asText());String name=row.path("name").asText();new TmapClient.Place(name,lon,lat);
   var addr=row.path("newAddressList").path("newAddress");String address=addr.isArray()&&!addr.isEmpty()?addr.get(0).path("fullAddressRoad").asText():"";
   if(address.isBlank())address=String.join(" ",row.path("upperAddrName").asText(),row.path("middleAddrName").asText(),row.path("lowerAddrName").asText());
   result.add(new Place(row.path("id").asText(),name,address.trim(),lon,lat));
  }catch(RuntimeException ignored){}}
  return List.copyOf(result);
 }
}
