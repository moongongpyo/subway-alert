package com.megabridge.subwayalert;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static com.megabridge.subwayalert.TmapClient.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

class RoutingServiceTests {
    private RoutingService.Snapshot finish(RoutingService service,String id) throws Exception {
        for(int i=0;i<100;i++) { var s=service.get("owner",id); if(!s.busy()) return s; Thread.sleep(10); }
        throw new AssertionError("Route evaluation did not complete");
    }
    private RoutingService.Decision decision(String verdict,String id) {return new RoutingService.Decision(verdict,id,"테스트 근거",List.of(),"simulation");}
    @Test void verifierRevisionReturnsToPlannerAndCompletesBoundedRetry() throws Exception {
        var gateway=mock(AgentGateway.class); when(gateway.configured()).thenReturn(true);
        AtomicInteger calls=new AtomicInteger();
        when(gateway.route(anyString(),any(),anyList(),nullable(RoutingService.Decision.class),anyInt())).thenAnswer(invocation->{
            calls.incrementAndGet(); String role=invocation.getArgument(0); int attempt=invocation.getArgument(4);
            if(role.equals("detector")) return decision("PROPOSE",attempt==0?"invented":"route-1");
            return decision(attempt==0?"REVISE":"APPROVED","route-1");
        });
        var service=new RoutingService(mock(TmapClient.class),gateway);
        try {
            var created=service.create("owner",PLACES.get("강남"),PLACES.get("선릉"),"DEMO");
            var result=finish(service,created.id());
            assertEquals("VERIFIED",result.state()); assertEquals("route-1",result.recommendedId()); assertEquals(4,calls.get());
            assertEquals("REVISE",result.traces().get(1).verdict());
        } finally {service.close();}
    }
    @Test void agreeingAgentsCannotOverrideServerGate() throws Exception {
        var gateway=mock(AgentGateway.class); when(gateway.configured()).thenReturn(true);
        when(gateway.route(anyString(),any(),anyList(),nullable(RoutingService.Decision.class),anyInt())).thenAnswer(invocation->
                decision(invocation.<String>getArgument(0).equals("detector")?"PROPOSE":"APPROVED","invented"));
        var service=new RoutingService(mock(TmapClient.class),gateway);
        try {
            var result=finish(service,service.create("owner",PLACES.get("강남"),PLACES.get("선릉"),"DEMO").id());
            assertEquals("VERIFY_PENDING",result.state()); assertEquals("",result.recommendedId());
        } finally {service.close();}
    }
}
