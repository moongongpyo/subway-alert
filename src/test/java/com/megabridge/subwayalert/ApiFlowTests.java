package com.megabridge.subwayalert;

import static org.junit.jupiter.api.Assertions.*;
import java.net.*;
import java.net.http.*;
import java.time.Duration;
import java.util.*;
import org.junit.jupiter.api.*;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@SpringBootTest(webEnvironment=SpringBootTest.WebEnvironment.RANDOM_PORT,properties={
    "spring.datasource.url=jdbc:h2:mem:flowtest;DB_CLOSE_DELAY=-1","app.demo-seed=false","app.admin-token=test-admin","app.poll-ms=3600000"})
class ApiFlowTests {
    @LocalServerPort int port;
    @Autowired JsonMapper json;
    @Autowired Store store;
    private HttpClient client() { return HttpClient.newBuilder().cookieHandler(new CookieManager(null,CookiePolicy.ACCEPT_ALL)).build(); }
    private HttpResponse<String> send(HttpClient client,String path,String method,Object body,String token) throws Exception {
        var builder=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api"+path)).timeout(Duration.ofSeconds(10)).header("X-Requested-With","SubwayAlert");
        if(token!=null) builder.header("X-Admin-Token",token);
        if(body!=null) builder.header("Content-Type","application/json");
        return client.send(builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body))).build(),HttpResponse.BodyHandlers.ofString());
    }
    private JsonNode dashboard(HttpClient c) throws Exception { var res=send(c,"/dashboard","GET",null,null); assertEquals(200,res.statusCode(),res.body()); return json.readTree(res.body()); }
    private JsonNode scenario(HttpClient c,String scenario,String requestId) throws Exception {
        var result=send(c,"/admin/scenarios","POST",Map.of("scenario",scenario,"station","역삼","direction","내선","requestId",requestId),null);
        assertEquals(202,result.statusCode(),result.body());
        for(int i=0;i<100;i++) { var d=dashboard(c); if(!d.path("busy").asBoolean()) return d; Thread.sleep(30); }
        fail("Scenario did not complete"); return null;
    }
    @Test void completeDemoDeduplicatesAndIsolatesUsersAndFailsClosed() throws Exception {
        var alice=client(); var bob=client(); dashboard(alice); dashboard(bob);
        var sub=send(alice,"/subscriptions","POST",Map.of("station","역삼","direction","내선"),null);
        assertEquals(200,sub.statusCode()); String subId=json.readTree(sub.body()).path("id").asText();
        send(bob,"/subscriptions/"+subId,"DELETE",null,null);
        assertEquals(1,dashboard(alice).path("subscriptions").size());
        assertEquals(200,send(alice,"/admin/mode","POST",Map.of("mode","DEMO"),null).statusCode());
        var noHeader=HttpRequest.newBuilder(URI.create("http://localhost:"+port+"/api/admin/mode")).header("Content-Type","application/json").POST(HttpRequest.BodyPublishers.ofString("{\"mode\":\"DEMO\"}")).build();
        assertEquals(403,alice.send(noHeader,HttpResponse.BodyHandlers.ofString()).statusCode());
        assertFalse(dashboard(alice).path("settings").path("seoulNoticeConfigured").asBoolean());
        for(String failure:List.of("STALE","FAILURE","TIMEOUT","INVALID_RESPONSE")) {
            var d=scenario(alice,failure,UUID.randomUUID().toString()); assertTrue(d.path("notifications").isEmpty(),failure);
        }
        String id=UUID.randomUUID().toString();
        var d=scenario(alice,"DELAY",id);
        assertEquals(1,d.path("notifications").size());
        assertTrue(d.path("notifications").get(0).path("title").asText().contains("[시연]"));
        assertTrue(d.path("messages").valueStream().anyMatch(m->m.path("type").asText().equals("REQUEST_REFRESH")));
        assertEquals(1,scenario(alice,"DELAY",id).path("notifications").size());
        assertEquals(1,scenario(alice,"DELAY",UUID.randomUUID().toString()).path("notifications").size());
        assertTrue(dashboard(bob).path("notifications").isEmpty());
        String noticeId=d.path("notifications").get(0).path("id").asText();
        assertEquals(404,send(bob,"/notifications/"+noticeId+"/read","PATCH",null,null).statusCode());
        assertEquals(200,send(alice,"/notifications/"+noticeId+"/read","PATCH",null,null).statusCode());
        d=scenario(alice,"RECOVERY",UUID.randomUUID().toString());
        assertEquals(2,d.path("notifications").size());
        assertEquals("RECOVERED",d.path("notifications").get(0).path("phase").asText());
        assertEquals(400,send(alice,"/admin/mode","POST",Map.of("mode","LIVE"),"test-admin").statusCode());
    }
    @Test void quotaStopsAtBudget() { assertTrue(store.reserveCalls(2,3)); assertFalse(store.reserveCalls(2,3)); assertTrue(store.reserveCalls(1,3)); assertEquals(3,store.callsToday()); }
    @Test void routeReplanningIsPrivateAndNeverInventsAnAlternative() throws Exception {
        var alice=client(); var bob=client(); dashboard(alice); dashboard(bob);
        var request=Map.of("from",TmapClient.PLACES.get("강남"),"to",TmapClient.PLACES.get("선릉"),"provider","DEMO");
        var response=send(alice,"/routes","POST",request,null); assertEquals(200,response.statusCode(),response.body());
        var plan=json.readTree(response.body()); String path="/routes/"+plan.path("id").asText();
        assertEquals("route-1",plan.path("recommendedId").asText());
        assertEquals(404,send(bob,path,"GET",null,null).statusCode());
        assertEquals(404,send(bob,path+"/avoid","POST",Map.of("legId","route-1-leg-0","scope","SEGMENT","reason","이용 불가"),null).statusCode());
        for(var leg:List.of("route-1-leg-0","route-2-leg-1","route-4-leg-1")) {
            response=send(alice,path+"/avoid","POST",Map.of("legId",leg,"scope","SEGMENT","reason","공사·통제"),null);
            assertEquals(200,response.statusCode(),response.body()); plan=json.readTree(response.body());
        }
        assertEquals("NO_ALTERNATIVE",plan.path("state").asText()); assertEquals("",plan.path("recommendedId").asText());
        String firstBlock=plan.path("blocks").get(0).path("id").asText();
        plan=json.readTree(send(alice,path+"/avoid/"+firstBlock,"DELETE",null,null).body());
        assertEquals("route-1",plan.path("recommendedId").asText());
        assertEquals(400,send(alice,path+"/avoid","POST",Map.of("legId","invented","scope","LINE","reason","이용 불가"),null).statusCode());
        assertEquals(503,send(alice,"/routes","POST",Map.of("from",TmapClient.PLACES.get("강남"),"to",TmapClient.PLACES.get("선릉"),"provider","TMAP"),null).statusCode());
    }
}
