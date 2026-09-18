package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.Models.*;
import java.time.Instant;
import java.util.*;

public final class DemoFactory {
    private DemoFactory() {}
    public static List<Observation> samples(String station,String direction,Scenario scenario,String cycle) {
        if(scenario==Scenario.FAILURE) return List.of();
        Instant now=Instant.now();
        boolean delayed=Set.of(Scenario.DELAY,Scenario.TIMEOUT,Scenario.INVALID_RESPONSE,Scenario.STALE).contains(scenario);
        List<Observation> rows=new ArrayList<>();
        for(int i=0;i<3;i++) {
            Instant generated=now.minusSeconds((2-i)*60L+(scenario==Scenario.STALE?600:0));
            rows.add(new Observation("obs-"+UUID.randomUUID(),Mode.DEMO,station,direction,"demo-"+cycle,
                    delayed?"역삼":List.of("선릉","역삼","강남").get(i),delayed?180+i*60:180-i*60,
                    generated,now,"합성 시연 데이터","{}"));
        }
        return rows;
    }
}
