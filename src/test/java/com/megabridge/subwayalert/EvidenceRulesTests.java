package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.Models.*;
import static org.junit.jupiter.api.Assertions.*;
import java.time.Instant;
import java.util.*;
import org.junit.jupiter.api.Test;

class EvidenceRulesTests {
    @Test void increasingEtaRequiresFreshDistinctSamplesOfTheSameTrain() {
        var rows=DemoFactory.samples("역삼","내선",Scenario.DELAY,"1");
        assertTrue(EvidenceRules.assess(rows,Instant.now(),180).candidate());
        assertFalse(EvidenceRules.assess(List.of(rows.getFirst(),rows.getFirst(),rows.getFirst()),Instant.now(),180).candidate());
        assertFalse(EvidenceRules.assess(DemoFactory.samples("역삼","내선",Scenario.STALE,"2"),Instant.now(),180).fresh());
        assertFalse(EvidenceRules.assess(DemoFactory.samples("역삼","내선",Scenario.NORMAL,"3"),Instant.now(),180).candidate());
        assertFalse(EvidenceRules.assess(rows,Instant.now().minusSeconds(900),180).fresh());
    }
    @Test void newerNormalTrainDoesNotHideAnotherTrainsDelay() {
        var rows=new ArrayList<>(DemoFactory.samples("역삼","내선",Scenario.DELAY,"delayed"));
        rows.addAll(DemoFactory.samples("역삼","내선",Scenario.NORMAL,"normal"));
        assertTrue(EvidenceRules.assess(rows,Instant.now(),180).candidate());
    }
    @Test void mixedTrainIdentitiesCannotMakeAPattern() {
        List<Observation> rows=new ArrayList<>();
        for(int i=0;i<3;i++) rows.add(DemoFactory.samples("역삼","내선",Scenario.DELAY,"train"+i).get(i));
        assertFalse(EvidenceRules.assess(rows,Instant.now(),180).candidate());
    }
    @Test void gatewayRejectsInventedEvidenceAndSimulatedLiveResults() {
        var rows=DemoFactory.samples("역삼","내선",Scenario.DELAY,"1");
        var request=new AgentRequest("job","verifier",Mode.DEMO,"역삼","내선",1,true,180,rows,Instant.now());
        assertThrows(IllegalArgumentException.class,()->AgentGateway.validate(new AgentResult(Verdict.ALERT_ALLOWED,"test",List.of("invented"),List.of(),"openai"),request));
        var live=new AgentRequest("job","verifier",Mode.LIVE,"역삼","내선",1,true,180,List.of(),Instant.now());
        assertThrows(IllegalArgumentException.class,()->AgentGateway.validate(new AgentResult(Verdict.REJECTED,"test",List.of(),List.of(),"simulation"),live));
    }
    @Test void seoulTimestampIsKoreaTime() {
        assertEquals(Instant.parse("2026-09-18T00:30:00Z"),SeoulClient.parseTime("2026-09-18 09:30:00"));
        assertEquals("123",SeoulClient.normalizeTrain("00123"));
    }
}
