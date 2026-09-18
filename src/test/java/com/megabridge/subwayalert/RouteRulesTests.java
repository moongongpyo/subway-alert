package com.megabridge.subwayalert;

import static org.junit.jupiter.api.Assertions.*;
import static com.megabridge.subwayalert.TmapClient.*;
import static com.megabridge.subwayalert.RouteRules.*;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class RouteRulesTests {
    private RoutePlan demo() {return RouteDemo.create(PLACES.get("강남"),PLACES.get("선릉"));}
    private Block block(Leg leg,String scope) {return new Block("b",scope,"이용 불가","DEMO",leg,Instant.now());}
    @Test void subwayThenBusAvoidanceSelectsSuccessiveAlternatives() {
        var plan=demo(); var blocks=new ArrayList<Block>();
        assertEquals("route-1",RoutingService.best(plan,assess(plan,blocks)));
        blocks.add(block(plan.journeys().get(0).legs().get(0),"SEGMENT"));
        assertEquals("route-2",RoutingService.best(plan,assess(plan,blocks)));
        assertFalse(assess(plan,blocks).get(2).eligible(),"Mixed route still crosses blocked subway segment");
        blocks.add(block(plan.journeys().get(1).legs().get(1),"LINE"));
        assertEquals("route-4",RoutingService.best(plan,assess(plan,blocks)));
        blocks.add(block(plan.journeys().get(3).legs().get(1),"LINE"));
        assertEquals("",RoutingService.best(plan,assess(plan,blocks)));
    }
    @Test void oppositeDirectionAndOtherBusOnSameSegmentAreExcluded() {
        var leg=demo().journeys().get(1).legs().get(1);
        var reverse=new Leg("reverse","BUS","다른 버스","different",11,leg.end(),leg.start(),100,"SCHEDULED",leg.stops().reversed());
        assertNotNull(conflict(reverse,block(leg,"SEGMENT")));
        assertNull(conflict(reverse,block(leg,"LINE")),"Line-only exclusion does not claim a street closure");
    }
    @Test void missingStopsCannotProveAvoidance() {
        var leg=demo().journeys().get(1).legs().get(1);
        var missing=new Leg("missing","BUS","다른 버스","x",11,"가","나",100,"SCHEDULED",List.of());
        assertNotNull(conflict(missing,block(leg,"SEGMENT")));
    }
    @Test void timetableUnavailableAndUnknownModesAreNotRecommended() {
        var plan=demo(); var leg=plan.journeys().getFirst().legs().getFirst();
        var invalid=new Leg(leg.id(),"SUBWAY",leg.route(),leg.routeId(),2,leg.start(),leg.end(),100,"NOT_SCHEDULED",leg.stops());
        var single=new RoutePlan("TMAP",plan.from(),plan.to(),Instant.now(),false,List.of(new Journey("one",100,null,0,0,100,List.of(invalid))),"");
        assertEquals("",RoutingService.best(single,assess(single,List.of())));
    }
}
