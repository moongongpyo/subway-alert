package com.megabridge.subwayalert;

import java.time.Instant;
import java.util.List;

public final class Models {
    private Models() {}
    public static final List<String> STATIONS = List.of("강남", "역삼", "선릉");
    public static final List<String> DIRECTIONS = List.of("내선", "외선");
    public enum Mode { DEMO, LIVE }
    public enum Scenario { NORMAL, DELAY, STALE, FAILURE, RECOVERY, TIMEOUT, INVALID_RESPONSE }
    public enum Verdict { ALERT_ALLOWED, REJECTED, NEEDS_MORE_DATA, COLLECTION_ERROR }
    public record Observation(String id, Mode mode, String station, String direction,
            String trainId, String position, int etaSeconds, Instant generatedAt,
            Instant collectedAt, String source, String raw) {}
    public record Incident(String id, Mode mode, String station, String direction,
            String state, String summary, List<String> evidenceIds, Instant createdAt, Instant updatedAt) {}
    public record AgentMessage(String id, String runId, String incidentId, String sender,
            String recipient, String type, String detail, int attempt, Instant createdAt) {}
    public record AgentJob(String id, String runId, String role, String state,
            String engine, String detail, Instant createdAt, Instant finishedAt) {}
    public record Subscription(String id, String owner, String station, String direction, Instant createdAt) {}
    public record Notice(String id, String owner, String incidentId, Mode mode,
            String station, String direction, String phase, String title, String body,
            Instant createdAt, boolean read) {}
    public record ToolTrace(String tool, String detail) {}
    public record AgentResult(Verdict verdict, String reason, List<String> evidenceIds,
            List<ToolTrace> tools, String engine) {}
    public record AgentRequest(String requestId, String role, Mode mode, String station,
            String direction, int attempt, boolean collectionHealthy, int freshSeconds,
            List<Observation> observations, Instant now) {}
    public record Run(String id, Mode mode, String scenario, String state, String detail,
            Instant startedAt, Instant finishedAt) {}
}
