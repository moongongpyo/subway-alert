package com.megabridge.subwayalert;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

@RestController
public class MetroNotices {
    record Notice(String title,String content,String lines,String stations,String category,String nonstop,
                  String direction,Instant publishedAt,Instant startsAt,Instant endsAt) {
        public String timing(Instant now) {
            if(endsAt!=null && !endsAt.isAfter(now)) return "ENDED";
            if(startsAt!=null && startsAt.isAfter(now)) return "SCHEDULED";
            if(startsAt!=null && endsAt!=null) return "TIME_WINDOW";
            return "UNKNOWN";
        }
    }
    record Feed(List<Notice> notices,int total) {}
    private record Cache(Feed feed,Instant fetchedAt,String error) {}
    private Instant lastAttempt=Instant.EPOCH;
    private volatile Cache cache=new Cache(new Feed(List.of(),0),null,"");
    private final JsonMapper json;
    private final Store store;
    private final HttpClient http=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
    @Value("${app.notice-key:}") private String key="";
    @Value("${app.notice-base-url:http://openapi.seoul.go.kr:8088}") private String base;
    @Value("${app.notice-daily-budget:800}") private int budget=800;
    public MetroNotices(JsonMapper json,Store store) { this.json=json; this.store=store; }
    boolean configured() { return !key.isBlank() && !key.startsWith("dtn_") && !key.startsWith("sk-"); }

    @Scheduled(initialDelay=3000,fixedDelayString="${app.notice-poll-ms:120000}")
    public synchronized void collect() {
        if(!configured() || lastAttempt.plusSeconds(15).isAfter(Instant.now())) return;
        lastAttempt=Instant.now();
        try {
            if(!store.reserveProviderCalls("SEOUL_NOTICE",1,budget)) throw new IllegalStateException();
            String url=base.replaceAll("/+$","")+"/"+URLEncoder.encode(key,StandardCharsets.UTF_8)+"/json/getNtceList/1/1000/";
            var response=http.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(12)).GET().build(),HttpResponse.BodyHandlers.ofInputStream());
            try(var stream=response.body()) {
                byte[] bytes=stream.readNBytes(5_000_001);
                if(response.statusCode()!=200 || bytes.length>5_000_000) throw new IllegalStateException();
                cache=new Cache(parse(json.readTree(new String(bytes,StandardCharsets.UTF_8))),Instant.now(),"");
            }
        } catch(Exception ignored) {
            // Request URIs contain credentials. Keep them out of logs and responses.
            var previous=cache;
            cache=new Cache(previous.feed,previous.fetchedAt,"공식 공지 수집 실패: 인증키·호출 한도·연결 상태를 확인하세요.");
        }
    }
    @PostMapping("/api/metro-notices/refresh")
    public Map<String,Object> refresh(jakarta.servlet.http.HttpServletRequest request) {
        if(!"SubwayAlert".equals(request.getHeader("X-Requested-With"))) throw new org.springframework.web.server.ResponseStatusException(org.springframework.http.HttpStatus.FORBIDDEN);
        collect();return snapshot();
    }
    @GetMapping("/api/metro-notices")
    public Map<String,Object> snapshot() {
        var value=cache; var now=Instant.now();
        boolean stale=value.fetchedAt==null || value.fetchedAt.plusSeconds(300).isBefore(now);
        return Map.of("configured",configured(),"stale",stale,"fetchedAt",value.fetchedAt==null?"":value.fetchedAt.toString(),
            "error",value.error,"total",value.feed.total,"truncated",value.feed.total>value.feed.notices.size(),
            "source","서울교통공사 · 또타 공식 공지", "items",value.feed.notices.stream().limit(100).map(n->Map.of("notice",n,"timing",n.timing(now))).toList());
    }
    static Feed parse(JsonNode root) {
        var response=root.path("response");
        if(!"00".equals(response.path("header").path("resultCode").asText())) throw new IllegalArgumentException("공지 API 오류");
        var body=response.path("body"); int total=body.path("totalCount").asInt(-1);
        if(total<0) throw new IllegalArgumentException("공지 개수 누락");
        var items=body.path("items").path("item");
        if(total==0) return new Feed(List.of(),0);
        if(items.isObject()) items=JsonMapper.builder().build().createArrayNode().add(items);
        if(!items.isArray() || items.isEmpty()) throw new IllegalArgumentException("공지 목록 누락");
        List<Notice> notices=new ArrayList<>();
        for(var n:items) {
            if(text(n,"noftTtl").isBlank() || text(n,"noftCn").isBlank()) continue;
            notices.add(new Notice(text(n,"noftTtl"),text(n,"noftCn"),text(n,"lineNmLst"),text(n,"stnSctnCdLst"),
                text(n,"noftSeCd"),text(n,"nonstopYn"),text(n,"upbdnbSe"),date(n,"noftOcrnDt"),date(n,"xcseSitnBgngDt"),date(n,"xcseSitnEndDt")));
        }
        if(notices.isEmpty()) throw new IllegalArgumentException("유효한 공지 없음");
        notices.sort(Comparator.comparing(Notice::publishedAt,Comparator.nullsLast(Comparator.reverseOrder())));
        return new Feed(List.copyOf(notices),total);
    }
    private static String text(JsonNode n,String field) { return n.path(field).asText(""); }
    private static Instant date(JsonNode n,String field) {
        var s=text(n,field); if(s.isBlank()) return null;
        try {return SeoulClient.parseTime(s);} catch(RuntimeException e) {return null;}
    }
}
