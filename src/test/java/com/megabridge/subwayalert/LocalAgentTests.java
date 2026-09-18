package com.megabridge.subwayalert;
import static org.junit.jupiter.api.Assertions.*;
import static com.megabridge.subwayalert.TmapClient.*;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.json.JsonMapper;

class LocalAgentTests {
 @Test void springExecutesToolsAndRejectsInventedRoute() throws Exception {
  var json=JsonMapper.builder().build();var calls=new AtomicInteger();var invalid=new java.util.concurrent.atomic.AtomicBoolean();
  var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
  server.createContext("/responses",e->{
   var body=json.readTree(new String(e.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));int step=calls.getAndIncrement()%3;
   assertFalse(body.path("store").asBoolean(true));assertEquals("Bearer test",e.getRequestHeaders().getFirst("Authorization"));
   if(step>0)assertTrue(body.path("input").toString().contains("function_call_output"));
   String name=step==0?"read_routes":step==1?"check_avoidance":"submit_route";
   String args=step<2?"{}":json.writeValueAsString(Map.of("verdict","PROPOSE","routeId",invalid.get()?"invented":"route-1","reason","도구로 최단 경로 확인"));
   byte[] out=json.writeValueAsBytes(Map.of("output",List.of(Map.of("type","function_call","call_id","call-"+step,"name",name,"arguments",args))));
   e.sendResponseHeaders(200,out.length);e.getResponseBody().write(out);e.close();
  });server.start();
  try {
   var gateway=new AgentGateway(json);ReflectionTestUtils.setField(gateway,"key","test");ReflectionTestUtils.setField(gateway,"endpoint","http://127.0.0.1:"+server.getAddress().getPort()+"/responses");
   var plan=RouteDemo.create(PLACES.get("강남"),PLACES.get("선릉"));
   var result=gateway.route("detector",plan,List.of(),null,0);assertEquals("openai",result.engine());assertEquals(2,result.tools().size());assertEquals("route-1",result.routeId());
   invalid.set(true);assertThrows(IllegalStateException.class,()->gateway.route("detector",plan,List.of(),null,0));assertEquals(6,calls.get());
  }finally{server.stop(0);}
 }
 @Test void noKeyNeverCallsFormerSandboxes() throws Exception {
  var gateway=new AgentGateway(JsonMapper.builder().build());assertFalse(gateway.configured());
  var plan=RouteDemo.create(PLACES.get("강남"),PLACES.get("선릉"));assertEquals("simulation",gateway.route("detector",plan,List.of(),null,0).engine());
 }
}
