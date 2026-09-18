package com.megabridge.subwayalert;
import java.time.*;
import java.util.*;
import org.springframework.stereotype.Service;

@Service
public class MockDisruptions {
 public record Event(String id,String title,TmapClient.Leg leg,Instant startsAt,Instant endsAt) {
  public boolean active(Instant now){return !now.isBefore(startsAt)&&now.isBefore(endsAt);}
 }
 private final Store store;public MockDisruptions(Store store){this.store=store;}
 public List<Event> list(){return store.list("mock-disruption","demo",100,Event.class);}
 public synchronized Event create(TmapClient.Leg leg,Instant start,Instant end){
  Instant now=Instant.now();if(start==null||end==null||!end.isAfter(start)||end.isAfter(start.plusSeconds(86400))||start.isAfter(now.plusSeconds(7*86400))||start.isBefore(now.minusSeconds(120))||!end.isAfter(now))throw new IllegalArgumentException("시작은 지금부터 7일 이내, 지속 시간은 최대 24시간으로 설정하세요.");
  if(!Set.of("BUS","SUBWAY").contains(leg.mode())||!RouteRules.completeStops(leg))throw new IllegalArgumentException("정류장 정보가 있는 버스·지하철 구간을 선택하세요.");
  if(list().stream().filter(e->e.endsAt.isAfter(now)).count()>=30)throw new IllegalArgumentException("진행·예약 장애는 최대 30개입니다.");
  var event=new Event(UUID.randomUUID().toString(),leg.route()+" "+leg.start()+" → "+leg.end(),leg,start,end);store.insert(event.id,"mock-disruption","demo",event);return event;
 }
 public void delete(String id){store.delete(id,"mock-disruption","demo");}
 public List<RouteRules.Block> blocks(Instant now){return list().stream().filter(e->e.active(now)).map(e->new RouteRules.Block("mock-"+e.id,"SEGMENT","시연 장애","MOCK",e.leg,e.startsAt)).toList();}
}
