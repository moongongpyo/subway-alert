package com.megabridge.subwayalert;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import static com.megabridge.subwayalert.TmapClient.*;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.concurrent.atomic.*;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.json.JsonMapper;

class TmapClientTests {
    private static final String RESPONSE="""
      {"metaData":{"plan":{"itineraries":[{"totalTime":720,"transferCount":0,"totalWalkTime":60,"legs":[
      {"mode":"SUBWAY","route":"수도권2호선","routeId":"2","type":2,"service":1,"sectionTime":660,
      "start":{"name":"강남"},"end":{"name":"선릉"},"passStopList":{"stationList":[
      {"stationID":"1","stationName":"강남"},{"stationID":"2","stationName":"역삼"},{"stationID":"3","stationName":"선릉"}]}}]}]}}}
      """;
    @Test void sendsOfficialContractCachesAndPreservesStops() throws Exception {
        var store=mock(Store.class);
        var json=JsonMapper.builder().build(); var count=new AtomicInteger(); var received=new AtomicReference<String>();
        var header=new AtomicReference<String>(); var method=new AtomicReference<String>();
        HttpServer server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/transit/routes",exchange->{
            count.incrementAndGet(); header.set(exchange.getRequestHeaders().getFirst("appKey")); method.set(exchange.getRequestMethod());
            received.set(new String(exchange.getRequestBody().readAllBytes(),StandardCharsets.UTF_8));
            byte[] bytes=RESPONSE.getBytes(StandardCharsets.UTF_8); exchange.sendResponseHeaders(200,bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        }); server.start();
        try {
            var client=new TmapClient(store,json);
            ReflectionTestUtils.setField(client,"key","test-key");
            ReflectionTestUtils.setField(client,"endpoint","http://127.0.0.1:"+server.getAddress().getPort()+"/transit/routes");
            var first=client.routes(PLACES.get("강남"),PLACES.get("선릉"));
            assertEquals(3,first.journeys().getFirst().legs().getFirst().stops().size()); assertNull(first.journeys().getFirst().totalFare());
            assertEquals("test-key",header.get()); assertEquals("POST",method.get()); assertEquals(10,json.readTree(received.get()).path("count").asInt());
            assertTrue(client.routes(PLACES.get("강남"),PLACES.get("선릉")).cached()); assertEquals(1,count.get());
            verify(store,times(1)).recordProviderCall("TMAP");
            // More than ten distinct provider requests remain allowed; cache stays enabled.
            for(int i=0;i<12;i++)client.routes(PLACES.get("역삼"),PLACES.get("선릉"),String.format("20260919%02d00",i));
            assertEquals(13,count.get());
            verify(store,never()).reserveProviderCalls(anyString(),anyInt(),anyInt());

        } finally {server.stop(0);}
    }
    @Test void missingKeyAndMalformedResponsesDoNotBecomeDemoRoutes() {
        var store=mock(Store.class); var json=JsonMapper.builder().build(); var client=new TmapClient(store,json);
        ReflectionTestUtils.setField(client,"key","");
        assertEquals(503,assertThrows(ResponseStatusException.class,()->client.routes(PLACES.get("강남"),PLACES.get("선릉"))).getStatusCode().value());
        verifyNoInteractions(store);
        assertThrows(IllegalArgumentException.class,()->TmapClient.parse(json.readTree("{}"),PLACES.get("강남"),PLACES.get("선릉"),Instant.now()));
    }
}
