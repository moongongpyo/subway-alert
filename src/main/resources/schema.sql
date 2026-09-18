CREATE TABLE IF NOT EXISTS app_records (
    id VARCHAR(200) PRIMARY KEY,
    kind VARCHAR(30) NOT NULL,
    scope VARCHAR(200) NOT NULL,
    created_at VARCHAR(40) NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_kind_scope ON app_records(kind, scope, created_at);
CREATE TABLE IF NOT EXISTS api_budget (
    budget_day VARCHAR(10) PRIMARY KEY,
    used_calls INTEGER NOT NULL
);
