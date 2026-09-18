package com.megabridge.subwayalert;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import java.time.Instant;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import tools.jackson.databind.json.JsonMapper;

class MetroNoticesTests {
    private final JsonMapper json=JsonMapper.builder().build();
    private static final String ROW="""
        {"noftTtl":"무정차 종료","noftCn":"정상 운행합니다","noftOcrnDt":"2026-09-18T10:00:00","lineNmLst":"2호선","xcseSitnEndDt":"2026-09-18T10:00:00"}
        """;
    private String response(String items) {return "{\"response\":{\"header\":{\"resultCode\":\"00\"},\"body\":{\"totalCount\":1,\"items\":{\"item\":"+items+"}}}}";}
    @Test void usesSeoulTimeAndDoesNotTreatMissingEndAsActiveIncident() {
        var notice=MetroNotices.parse(json.readTree(response("["+ROW+"]"))).notices().getFirst();
        assertEquals(Instant.parse("2026-09-18T01:00:00Z"),notice.endsAt());
        assertEquals("ENDED",notice.timing(Instant.parse("2026-09-18T02:00:00Z")));
        var unknown=MetroNotices.parse(json.readTree(response(ROW.replace("xcseSitnEndDt","unknown")))).notices().getFirst();
        assertEquals("UNKNOWN",unknown.timing(Instant.parse("2026-09-18T02:00:00Z")));
        assertThrows(IllegalArgumentException.class,()->MetroNotices.parse(json.readTree("{\"RESULT\":{\"CODE\":\"INFO-100\"}}")));
    }
    @Test void collectsOfficialEnvelopeAndRetainsDataOnFailureWithoutLeakingKey() throws Exception {
        var store=mock(Store.class);when(store.reserveProviderCalls("SEOUL_NOTICE",1,800)).thenReturn(true);
        var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/test-key/json/getNtceList/1/1000/",e->{byte[] b=response("["+ROW+"]").getBytes(StandardCharsets.UTF_8);e.sendResponseHeaders(200,b.length);e.getResponseBody().write(b);e.close();});server.start();
        var client=new MetroNotices(json,store);ReflectionTestUtils.setField(client,"key","test-key");ReflectionTestUtils.setField(client,"base","http://127.0.0.1:"+server.getAddress().getPort());
        try {client.collect();assertEquals(1,client.snapshot().get("total"));assertEquals(false,client.snapshot().get("stale"));}
        finally {server.stop(0);}
        when(store.reserveProviderCalls("SEOUL_NOTICE",1,800)).thenReturn(false);ReflectionTestUtils.setField(client,"lastAttempt",Instant.EPOCH);client.collect();
        assertEquals(1,client.snapshot().get("total"));assertFalse(client.snapshot().get("error").toString().contains("test-key"));assertFalse(client.snapshot().get("error").toString().isBlank());
    }
    @Test void daytonaKeysAreNeverSentToSeoul() {
        var store=mock(Store.class);var client=new MetroNotices(json,store);ReflectionTestUtils.setField(client,"key","dtn_wrong-provider");client.collect();assertFalse(client.configured());verifyNoInteractions(store);
    }
}
