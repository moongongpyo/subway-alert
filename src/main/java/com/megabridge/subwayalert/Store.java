package com.megabridge.subwayalert;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.dao.DuplicateKeyException;
import tools.jackson.databind.json.JsonMapper;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;

@Repository
public class Store {
    private static final java.time.format.DateTimeFormatter ORDERED_TIME=new java.time.format.DateTimeFormatterBuilder().appendInstant(9).toFormatter();
    private final JdbcTemplate jdbc;
    private final JsonMapper json;
    public Store(JdbcTemplate jdbc, JsonMapper json) { this.jdbc=jdbc; this.json=json; }
    public synchronized void put(String id, String kind, String scope, Object value) {
        String payload=json.writeValueAsString(value);
        int updated=jdbc.update("UPDATE app_records SET payload=? WHERE id=? AND kind=?",payload,id,kind);
        if(updated==0) insert(id,kind,scope,value);
    }
    public boolean insert(String id,String kind,String scope,Object value) {
        try {
            jdbc.update("INSERT INTO app_records(id,kind,scope,created_at,payload) VALUES(?,?,?,?,?)",
                    id,kind,scope,ORDERED_TIME.format(Instant.now()),json.writeValueAsString(value));
            return true;
        } catch(DuplicateKeyException duplicate) { return false; }
    }
    public <T> Optional<T> get(String id,String kind,Class<T> type) {
        return jdbc.query("SELECT payload FROM app_records WHERE id=? AND kind=?",
                (rs,n)->json.readValue(rs.getString(1),type),id,kind).stream().findFirst();
    }
    public <T> List<T> list(String kind,String scope,int limit,Class<T> type) {
        int safeLimit=Math.max(1,Math.min(1000,limit));
        if(scope==null) return jdbc.query("SELECT payload FROM app_records WHERE kind=? ORDER BY created_at DESC,id DESC LIMIT ?",
                (rs,n)->json.readValue(rs.getString(1),type),kind,safeLimit);
        return jdbc.query("SELECT payload FROM app_records WHERE kind=? AND scope=? ORDER BY created_at DESC,id DESC LIMIT ?",
                (rs,n)->json.readValue(rs.getString(1),type),kind,scope,safeLimit);
    }
    public void delete(String id,String kind,String scope) {
        jdbc.update("DELETE FROM app_records WHERE id=? AND kind=? AND scope=?",id,kind,scope);
    }
    public synchronized boolean reserveCalls(int count,int limit) {
        String day=LocalDate.now(ZoneId.of("Asia/Seoul")).toString();
        try { jdbc.update("INSERT INTO api_budget(budget_day,used_calls) VALUES(?,0)",day); }
        catch(DuplicateKeyException ignored) { }
        return jdbc.update("UPDATE api_budget SET used_calls=used_calls+? WHERE budget_day=? AND used_calls+?<=?",
                count,day,count,limit)==1;
    }
    public int callsToday() {
        return jdbc.query("SELECT used_calls FROM api_budget WHERE budget_day=?",(rs,n)->rs.getInt(1),
                LocalDate.now(ZoneId.of("Asia/Seoul")).toString()).stream().findFirst().orElse(0);
    }
    public synchronized void recordProviderCall(String provider) {
        String day=LocalDate.now(ZoneId.of("Asia/Seoul")).toString();
        try { jdbc.update("INSERT INTO provider_budget(provider,budget_day,used_calls) VALUES(?,?,0)",provider,day); }
        catch(DuplicateKeyException ignored) { }
        jdbc.update("UPDATE provider_budget SET used_calls=used_calls+1 WHERE provider=? AND budget_day=?",provider,day);
    }
    public synchronized boolean reserveProviderCalls(String provider,int count,int limit) {
        String day=LocalDate.now(ZoneId.of("Asia/Seoul")).toString();
        try { jdbc.update("INSERT INTO provider_budget(provider,budget_day,used_calls) VALUES(?,?,0)",provider,day); }
        catch(DuplicateKeyException ignored) { }
        return jdbc.update("UPDATE provider_budget SET used_calls=used_calls+? WHERE provider=? AND budget_day=? AND used_calls+?<=?",count,provider,day,count,limit)==1;
    }
    public int providerCallsToday(String provider) {
        return jdbc.query("SELECT used_calls FROM provider_budget WHERE provider=? AND budget_day=?",(rs,n)->rs.getInt(1),provider,
                LocalDate.now(ZoneId.of("Asia/Seoul")).toString()).stream().findFirst().orElse(0);
    }
    public void prune() {
        String cutoff=ORDERED_TIME.format(Instant.now().minusSeconds(7*86400));
        jdbc.update("DELETE FROM app_records WHERE kind IN ('observation','message','job','run') AND created_at<?",cutoff);
    }
}
