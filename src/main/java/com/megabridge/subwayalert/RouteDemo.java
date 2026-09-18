package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.TmapClient.*;
import java.time.Instant;
import java.util.*;

final class RouteDemo {
    static RoutePlan create(Place from,Place to) {
        // Fictional bus names and times deliberately distinguish fixtures from provider responses.
        String a=from.name(),b=to.name();
        return new RoutePlan("DEMO",from,to,Instant.now(),false,List.of(
            journey("route-1",720,0,180,List.of(leg("route-1-leg-0","SUBWAY","시연 2호선",2,a,b,540,List.of(a,"시연 중간역",b)),walk("route-1-leg-1",b,"목적지",180))),
            journey("route-2",1200,0,300,List.of(walk("route-2-leg-0","출발지",a+" 버스정류장",180),leg("route-2-leg-1","BUS","시연 버스 A",11,a+" 버스정류장",b+" 버스정류장",900,List.of(a+" 버스정류장","시연 중앙정류장",b+" 버스정류장")),walk("route-2-leg-2",b+" 버스정류장","목적지",120))),
            journey("route-3",1080,1,240,List.of(leg("route-3-leg-0","SUBWAY","시연 2호선",2,a,"시연 중간역",400,List.of(a,"시연 중간역")),leg("route-3-leg-1","BUS","시연 환승버스",11,"시연 중간역",b,440,List.of("시연 중간역",b)),walk("route-3-leg-2",b,"목적지",240))),
            journey("route-4",1620,0,480,List.of(walk("route-4-leg-0","출발지","시연 우회정류장",240),leg("route-4-leg-1","BUS","시연 버스 B",11,"시연 우회정류장",b+" 북측정류장",1140,List.of("시연 우회정류장","시연 북측거리",b+" 북측정류장")),walk("route-4-leg-2",b+" 북측정류장","목적지",240)))
        ),"합성 경로 · 노선·소요시간은 시연용이며 실제 이동에 사용할 수 없습니다.");
    }
    private static Journey journey(String id,int total,int transfers,int walk,List<Leg> legs) { return new Journey(id,total,1500,transfers,walk,3000,legs); }
    private static Leg leg(String id,String mode,String route,int type,String start,String end,int seconds,List<String> stops) {
        return new Leg(id,mode,route,route,type,start,end,seconds,"SCHEDULED",stops.stream().map(s->new Stop(s,s)).toList());
    }
    private static Leg walk(String id,String start,String end,int seconds) { return new Leg(id,"WALK","도보","",-1,start,end,seconds,"UNKNOWN",List.of()); }
}
