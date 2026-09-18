-- Optional budget initialization for a NEW database (PostgreSQL and H2).
-- No reference rows are required. Spring creates counters when APIs are called.
-- Run with the database session date set to Asia/Seoul if using this optional file.
-- Existing counts are never reset; no production records or active mock incidents are copied.
INSERT INTO api_budget (budget_day, used_calls)
SELECT CAST(CURRENT_DATE AS VARCHAR(10)), 0
WHERE NOT EXISTS (SELECT 1 FROM api_budget WHERE budget_day=CAST(CURRENT_DATE AS VARCHAR(10)));
INSERT INTO provider_budget (provider,budget_day,used_calls)
SELECT 'TMAP', CAST(CURRENT_DATE AS VARCHAR(10)), 0
WHERE NOT EXISTS (SELECT 1 FROM provider_budget WHERE provider='TMAP' AND budget_day=CAST(CURRENT_DATE AS VARCHAR(10)));
INSERT INTO provider_budget (provider,budget_day,used_calls)
SELECT 'TMAP_POI', CAST(CURRENT_DATE AS VARCHAR(10)), 0
WHERE NOT EXISTS (SELECT 1 FROM provider_budget WHERE provider='TMAP_POI' AND budget_day=CAST(CURRENT_DATE AS VARCHAR(10)));
INSERT INTO provider_budget (provider,budget_day,used_calls)
SELECT 'SEOUL_NOTICE', CAST(CURRENT_DATE AS VARCHAR(10)), 0
WHERE NOT EXISTS (SELECT 1 FROM provider_budget WHERE provider='SEOUL_NOTICE' AND budget_day=CAST(CURRENT_DATE AS VARCHAR(10)));
