package com.megabridge.subwayalert;

import static com.megabridge.subwayalert.TmapClient.*;
import java.time.Instant;
import java.util.*;

/** Deterministic gate: an LLM cannot override a blocked or uncheckable segment. */
public final class RouteRules {
    private RouteRules() {}
    public record Block(String id,String scope,String reason,String source,Leg leg,Instant createdAt) {}
    public record Assessment(String routeId,boolean eligible,List<String> reasons,int extraSeconds) {}
    public static List<Assessment> assess(RoutePlan plan,List<Block> blocks) {
        int baseline=plan.journeys().stream().mapToInt(Journey::totalSeconds).min().orElse(0);
        return plan.journeys().stream().map(journey->{
            Set<String> reasons=new LinkedHashSet<>();
            for(Leg leg:journey.legs()) {
                if(leg.start().isBlank() || leg.end().isBlank() || leg.durationSeconds()<0) reasons.add("구간 정보 부족");
                if(!Set.of("WALK","BUS","SUBWAY").contains(leg.mode())) reasons.add("현재 검증 범위 밖의 이동수단");
                if(!leg.mode().equals("WALK") && !leg.service().equals("SCHEDULED")) reasons.add("운행 시간표 확인 필요");
                for(Block block:blocks) {
                    String conflict=conflict(leg,block);
                    if(conflict!=null) reasons.add(conflict+" · "+block.leg().route()+" "+block.leg().start()+" → "+block.leg().end());
                }
            }
            return new Assessment(journey.id(),reasons.isEmpty(),List.copyOf(reasons),journey.totalSeconds()-baseline);
        }).toList();
    }
    static String conflict(Leg leg,Block block) {
        Leg denied=block.leg();
        if(!leg.mode().equals(denied.mode()) || leg.mode().equals("WALK")) return null;
        boolean same=sameService(leg,denied);
        if(block.scope().equals("LINE")) return same?"회피 노선 포함":(identityMissing(leg)||identityMissing(denied)?"노선 식별 정보 부족":null);
        if(!completeStops(leg) || !completeStops(denied)) return same?"구간 정보 부족으로 같은 노선 제외":"구간 회피 여부 확인 불가";
        List<Stop> a=leg.stops(),b=denied.stops();
        for(int i=1;i<a.size();i++) for(int k=1;k<b.size();k++) {
            if((sameStop(a.get(i-1),b.get(k-1)) && sameStop(a.get(i),b.get(k)))
                    || (sameStop(a.get(i-1),b.get(k)) && sameStop(a.get(i),b.get(k-1)))) return "이용 불가 구간 포함";
        }
        // Different IDs/names on the same service can hide overlap; do not assume disjoint from unknown identifiers.
        if(same && a.stream().noneMatch(x->b.stream().anyMatch(y->sameStop(x,y)))) return "같은 노선의 구간 분리 확인 필요";
        return null;
    }
    static boolean completeStops(Leg leg) {
        return leg.stops().size()>=2 && leg.stops().stream().allMatch(s->!s.name().isBlank())
                && normal(leg.stops().getFirst().name()).equals(normal(leg.start()))
                && normal(leg.stops().getLast().name()).equals(normal(leg.end()));
    }
    static boolean sameStop(Stop a,Stop b) {
        return (!a.id().isBlank() && a.id().equals(b.id())) || (!a.name().isBlank() && normal(a.name()).equals(normal(b.name())));
    }
    static boolean sameService(Leg a,Leg b) {
        if(!a.mode().equals(b.mode())) return false;
        return (!a.routeId().isBlank() && a.routeId().equals(b.routeId()))
                || (!a.route().isBlank() && normal(a.route()).equals(normal(b.route())))
                || (a.mode().equals("SUBWAY") && a.type()>0 && a.type()==b.type());
    }
    private static boolean identityMissing(Leg leg) { return leg.route().isBlank() && leg.routeId().isBlank(); }
    private static String normal(String text) { return text.replaceAll("\\s+","").toLowerCase(Locale.ROOT); }
}
