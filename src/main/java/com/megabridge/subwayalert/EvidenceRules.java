package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.Models.*;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

public final class EvidenceRules {
    private EvidenceRules() {}
    public record Assessment(boolean fresh, boolean candidate, List<String> evidenceIds, String reason) {}
    public static Assessment assess(List<Observation> observations,Instant now,int freshSeconds) {
        Map<String,List<Observation>> groups=new LinkedHashMap<>();
        for(Observation o:observations) groups.computeIfAbsent(o.mode()+":"+o.station()+":"+o.direction()+":"+o.trainId(),ignored->new ArrayList<>()).add(o);
        Assessment fallback=null;
        Instant newest=Instant.MIN;
        for(List<Observation> group:groups.values()) {
            Assessment assessed=assessTrain(group,now,freshSeconds);
            if(assessed.fresh() && assessed.candidate()) return assessed;
            Instant timestamp=group.stream().map(Observation::generatedAt).filter(Objects::nonNull).max(Comparator.naturalOrder()).orElse(Instant.MIN);
            if(fallback==null || timestamp.isAfter(newest)) { fallback=assessed; newest=timestamp; }
        }
        return fallback==null?new Assessment(false,false,List.of(),"관측 데이터가 없습니다."):fallback;
    }
    private static Assessment assessTrain(List<Observation> observations,Instant now,int freshSeconds) {
        List<Observation> ordered=observations.stream().filter(o->o.generatedAt()!=null)
                .sorted(Comparator.comparing(Observation::generatedAt)).toList();
        if(ordered.isEmpty()) return new Assessment(false,false,List.of(),"관측 데이터가 없습니다.");
        Observation latest=ordered.getLast();
        long age=Duration.between(latest.generatedAt(),now).getSeconds();
        if(age>freshSeconds || age < -30) return new Assessment(false,false,List.of(latest.id()),"데이터 생성 시각이 오래되었거나 미래입니다.");
        Map<String,Observation> distinct=new TreeMap<>();
        for(Observation o:ordered) {
            if(o.mode()==latest.mode() && o.station().equals(latest.station()) && o.direction().equals(latest.direction())
                    && o.trainId().equals(latest.trainId()) && Duration.between(o.generatedAt(),now).getSeconds()<=600
                    && Duration.between(o.generatedAt(),now).getSeconds()>=-30)
                distinct.put(o.generatedAt().toString(),o);
        }
        List<Observation> trend=new ArrayList<>(distinct.values());
        if(trend.size()<3) return new Assessment(true,false,trend.stream().map(Observation::id).toList(),"서로 다른 생성 시각의 관측이 3개 이상 필요합니다.");
        List<Observation> last=trend.subList(trend.size()-3,trend.size());
        boolean stationary=last.stream().allMatch(o->!o.position().isBlank() && o.position().equals(latest.position()));
        boolean worsening=last.get(1).etaSeconds()>last.get(0).etaSeconds() && last.get(2).etaSeconds()>last.get(1).etaSeconds();
        boolean enoughTime=Duration.between(last.getFirst().generatedAt(),last.getLast().generatedAt()).getSeconds()>=60;
        boolean candidate=stationary && worsening && enoughTime;
        return new Assessment(true,candidate,last.stream().map(Observation::id).toList(),candidate?
                "생성 시각이 갱신된 3회 관측에서 같은 위치가 유지되고 도착예정시간이 연속 증가했습니다.":"현재 관측에서 지연 의심 조건이 충족되지 않았습니다.");
    }
}
