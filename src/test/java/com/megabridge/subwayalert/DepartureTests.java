package com.megabridge.subwayalert;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.json.JsonMapper;
class DepartureTests {
 @Test void rejectsInvalidCalendarValues(){
  assertEquals("",TmapClient.validateDeparture(null));
  assertEquals("202609191200",TmapClient.validateDeparture("202609191200"));
  for(var s:List.of("202602301200","202609192500","189901011200","2026-09-19T12:00"))assertThrows(IllegalArgumentException.class,()->TmapClient.validateDeparture(s));
 }
 @Test void forwardsDepartureAndSeparatesCache()throws Exception{
  var requests=new ArrayList<String>();var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
  server.createContext("/routes",exchange->{requests.add(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));byte[] body="{\"metaData\":{\"plan\":{\"itineraries\":[]}}}".getBytes(StandardCharsets.UTF_8);exchange.sendResponseHeaders(200,body.length);exchange.getResponseBody().write(body);exchange.close();});server.start();
  try{
   var store=mock(Store.class);
   var json=JsonMapper.builder().build();var client=new TmapClient(store,json);
   ReflectionTestUtils.setField(client,"key","test");ReflectionTestUtils.setField(client,"endpoint","http://127.0.0.1:"+server.getAddress().getPort()+"/routes");
   var a=TmapClient.PLACES.get("강남");var b=TmapClient.PLACES.get("선릉");
   client.routes(a,b,"202609191200");client.routes(a,b,"202609192300");assertTrue(client.routes(a,b,"202609191200").cached());client.routes(a,b);
   assertEquals(3,requests.size());assertEquals("202609191200",json.readTree(requests.get(0)).path("searchDttm").asText());assertEquals("202609192300",json.readTree(requests.get(1)).path("searchDttm").asText());assertFalse(json.readTree(requests.get(2)).has("searchDttm"));
  }finally{server.stop(0);}
 }
}
