package com.megabridge.subwayalert;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static com.megabridge.subwayalert.TmapClient.*;
import java.time.*;
import java.util.*;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

class PlaceAndMockTests {
 @Test void poiUsesGeographicCoordinatesAndDropsInvalidRows(){
  var json=JsonMapper.builder().build();var rows=PlaceSearch.parse(json.readTree("""
   {"searchPoiInfo":{"pois":{"poi":[{"id":"1","name":"강남역","frontLon":"127.0279","frontLat":"37.4980","newAddressList":{"newAddress":[{"fullAddressRoad":"서울 강남대로"}]}},{"name":"잘못된 좌표","frontLon":"0","frontLat":"0"}]}}}
   """));assertEquals(1,rows.size());assertEquals("서울 강남대로",rows.getFirst().address());assertEquals(127.0279,rows.getFirst().lon());
 }
 @Test void timeBoundariesAndNormalRoutesAreIsolated() {
  var store=mock(Store.class);var mocks=new MockDisruptions(store);var plan=RouteDemo.create(PLACES.get("강남"),PLACES.get("선릉"));var leg=plan.journeys().getFirst().legs().getFirst();
  Instant start=Instant.now().minusSeconds(1),end=start.plusSeconds(60);var event=new MockDisruptions.Event("test","시연",leg,start,end);
  when(store.list("mock-disruption","demo",100,MockDisruptions.Event.class)).thenReturn(List.of(event));
  assertTrue(mocks.blocks(start.minusSeconds(1)).isEmpty());assertEquals(1,mocks.blocks(start).size());assertTrue(mocks.blocks(end).isEmpty());
  var gateway=mock(AgentGateway.class);var service=new RoutingService(mock(TmapClient.class),gateway,mocks);
  try {
   var normal=service.create("owner",PLACES.get("강남"),PLACES.get("선릉"),"DEMO",false);assertEquals("route-1",normal.recommendedId());assertTrue(normal.blocks().isEmpty());
   var simulation=service.create("owner",PLACES.get("강남"),PLACES.get("선릉"),"DEMO",true);assertEquals("route-2",simulation.recommendedId());assertEquals("MOCK",simulation.blocks().getFirst().source());
   service.remove("owner",simulation.id(),"mock-test");assertEquals("route-2",service.get("owner",simulation.id()).recommendedId());
   when(store.list("mock-disruption","demo",100,MockDisruptions.Event.class)).thenReturn(List.of());assertEquals("route-1",service.get("owner",simulation.id()).recommendedId());
   when(store.list("mock-disruption","demo",100,MockDisruptions.Event.class)).thenReturn(List.of(event));assertEquals("route-2",service.get("owner",simulation.id()).recommendedId());
  }finally{service.close();}
 }
}
