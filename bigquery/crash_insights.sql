-- Daily crash-insights build (BigQuery scheduled query, us-east1, runs as
-- bsod-stats-scheduler). Free-tier friendly: facts are merged incrementally from
-- the last 2 days of partitions; everything else aggregates the small job_facts.
-- Routines: bigquery/routines.sql. Full rebuild: bigquery/job_facts_full.sql.
-- Only aggregates leave bsod_corpus; nothing here exposes raw output or paths.
DECLARE since TIMESTAMP DEFAULT (
  SELECT TIMESTAMP_SUB(IFNULL(MAX(completed_at), TIMESTAMP '2000-01-01'), INTERVAL 2 DAY)
  FROM `project-bigfoot.bsod_corpus.job_facts`);
DECLARE ai_since TIMESTAMP DEFAULT TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 2 DAY);

-- 1. Facts: new/changed jobs, then newer AI reports for older jobs ------------
MERGE `project-bigfoot.bsod_corpus.job_facts` T
USING (SELECT * FROM `project-bigfoot.bsod_corpus.job_facts_since`(since)) S
ON T.job_id = S.job_id
WHEN MATCHED THEN UPDATE SET submitted_at = S.submitted_at, completed_at = S.completed_at, dump_type = S.dump_type, file_size_bytes = S.file_size_bytes, analysis_seconds = S.analysis_seconds, bugcheck_code = S.bugcheck_code, bugcheck_name = S.bugcheck_name, failure_bucket = S.failure_bucket, module_name = S.module_name, image_name = S.image_name, image_version = S.image_version, process_name = S.process_name, arch = S.arch, processor_count = S.processor_count, stack_depth = S.stack_depth, os_build = S.os_build, product_type = S.product_type, windows_release = S.windows_release, uptime_seconds = S.uptime_seconds, crash_utc_weekday = S.crash_utc_weekday, crash_utc_hour = S.crash_utc_hour, gpu_stack = S.gpu_stack, ai_origin = S.ai_origin, ai_culprit = S.ai_culprit, ai_hardware_error = S.ai_hardware_error, ai_hardware_bucket = S.ai_hardware_bucket, ai_culprit_drivers = S.ai_culprit_drivers, ai_model = S.ai_model
WHEN NOT MATCHED THEN INSERT ROW;

MERGE `project-bigfoot.bsod_corpus.job_facts` T
USING (SELECT * FROM `project-bigfoot.bsod_corpus.ai_facts_since`(ai_since)) S
ON T.job_id = S.job_id
WHEN MATCHED AND (T.ai_model IS NULL OR S.ai_origin != 'regenerated' OR T.ai_origin = 'regenerated')
  THEN UPDATE SET ai_origin = S.ai_origin, ai_culprit = S.ai_culprit, ai_hardware_error = S.ai_hardware_error, ai_hardware_bucket = S.ai_hardware_bucket, ai_culprit_drivers = S.ai_culprit_drivers, ai_model = S.ai_model;

-- 2. Public insights (one JSON row) ------------------------------------------
CREATE OR REPLACE TABLE `project-bigfoot.bsod_stats.corpus_insights` AS
WITH t AS (SELECT * FROM `project-bigfoot.bsod_corpus.job_facts`),
drivers AS (SELECT t.job_id, d.* FROM t, UNNEST(t.ai_culprit_drivers) d),
top_codes AS (SELECT bugcheck_code FROM t WHERE bugcheck_code IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 8),
top_images AS (SELECT image_name FROM t WHERE image_name IS NOT NULL AND image_name NOT IN ('unknown_image', 'ntkrnlmp.exe', 'ntoskrnl.exe') GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 8),
trend_codes AS (SELECT bugcheck_code FROM t WHERE bugcheck_code IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 6)
SELECT CURRENT_TIMESTAMP() AS generated_at, TO_JSON_STRING(STRUCT(
  'bsod_corpus_insights_v1' AS schema,
  STRUCT(
    (SELECT COUNT(*) FROM t) AS analyses,
    (SELECT COUNT(DISTINCT image_name) FROM t) AS distinct_modules,
    (SELECT APPROX_QUANTILES(analysis_seconds, 100)[OFFSET(50)] FROM t WHERE analysis_seconds >= 0) AS median_analysis_seconds,
    (SELECT APPROX_QUANTILES(uptime_seconds, 100)[OFFSET(50)] FROM t WHERE uptime_seconds IS NOT NULL) AS median_uptime_seconds,
    (SELECT COUNTIF(uptime_seconds < 60) FROM t) AS crashes_within_first_minute,
    (SELECT ROUND(SAFE_DIVIDE(COUNTIF(ai_hardware_error), COUNTIF(ai_model IS NOT NULL)), 4) FROM t) AS ai_hardware_share,
    (SELECT MIN(completed_at) FROM t) AS since
  ) AS totals,
  ARRAY(SELECT AS STRUCT b AS k, COUNT(*) AS n FROM (
    SELECT CASE WHEN uptime_seconds < 60 THEN '< 1 min' WHEN uptime_seconds < 600 THEN '1-10 min'
      WHEN uptime_seconds < 3600 THEN '10-60 min' WHEN uptime_seconds < 21600 THEN '1-6 h'
      WHEN uptime_seconds < 86400 THEN '6-24 h' WHEN uptime_seconds < 604800 THEN '1-7 days' ELSE '> 7 days' END AS b,
      CASE WHEN uptime_seconds < 60 THEN 1 WHEN uptime_seconds < 600 THEN 2 WHEN uptime_seconds < 3600 THEN 3
      WHEN uptime_seconds < 21600 THEN 4 WHEN uptime_seconds < 86400 THEN 5 WHEN uptime_seconds < 604800 THEN 6 ELSE 7 END AS o
    FROM t WHERE uptime_seconds IS NOT NULL) GROUP BY b, o ORDER BY o) AS uptime,
  ARRAY(SELECT AS STRUCT crash_utc_weekday AS d, crash_utc_hour AS h, COUNT(*) AS n FROM t
    WHERE crash_utc_weekday IS NOT NULL AND crash_utc_hour IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2) AS utc_heatmap,
  ARRAY(SELECT AS STRUCT windows_release AS k, COUNT(*) AS n FROM t GROUP BY 1 ORDER BY n DESC) AS windows_releases,
  ARRAY(SELECT AS STRUCT IFNULL(product_type, 'Unknown') AS k, COUNT(*) AS n FROM t GROUP BY 1 ORDER BY n DESC) AS product_types,
  ARRAY(SELECT AS STRUCT k, COUNT(*) AS n, MIN(o) AS o FROM (
    SELECT CASE WHEN processor_count <= 4 THEN '2-4' WHEN processor_count <= 8 THEN '6-8' WHEN processor_count <= 12 THEN '10-12'
      WHEN processor_count <= 16 THEN '14-16' WHEN processor_count <= 24 THEN '18-24' WHEN processor_count <= 32 THEN '28-32' ELSE '33+' END AS k,
      CASE WHEN processor_count <= 4 THEN 1 WHEN processor_count <= 8 THEN 2 WHEN processor_count <= 12 THEN 3
      WHEN processor_count <= 16 THEN 4 WHEN processor_count <= 24 THEN 5 WHEN processor_count <= 32 THEN 6 ELSE 7 END AS o
    FROM t WHERE processor_count IS NOT NULL) GROUP BY k ORDER BY o) AS cpu_threads,
  ARRAY(SELECT AS STRUCT gpu_stack AS k, COUNT(*) AS n FROM t WHERE gpu_stack IS NOT NULL GROUP BY 1 ORDER BY n DESC) AS gpu_stacks,
  ARRAY(SELECT AS STRUCT category AS k, COUNT(DISTINCT job_id) AS n FROM drivers WHERE category IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 10) AS ai_driver_categories,
  ARRAY(SELECT AS STRUCT manufacturer AS k, COUNT(DISTINCT job_id) AS n FROM drivers WHERE manufacturer != 'Unknown' GROUP BY 1 ORDER BY n DESC LIMIT 12) AS ai_manufacturers,
  STRUCT(
    (SELECT COUNTIF(ai_hardware_error) FROM t) AS hardware,
    (SELECT COUNTIF(ai_model IS NOT NULL AND ai_hardware_error IS NOT TRUE) FROM t) AS software
  ) AS ai_hardware_split,
  ARRAY(SELECT AS STRUCT ai_hardware_bucket AS k, COUNT(*) AS n FROM t WHERE ai_hardware_bucket IS NOT NULL GROUP BY 1 ORDER BY n DESC) AS ai_hardware_types,
  ARRAY(SELECT AS STRUCT process_name AS k, COUNT(*) AS n FROM t WHERE process_name IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 12) AS processes,
  ARRAY(SELECT AS STRUCT t.bugcheck_code AS code, ANY_VALUE(t.bugcheck_name) AS name,
    ARRAY_AGG(STRUCT(wk AS w, n) ORDER BY wk) AS weeks FROM (
      SELECT bugcheck_code, bugcheck_name, FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(completed_at), ISOWEEK)) AS wk, COUNT(*) OVER (PARTITION BY bugcheck_code, DATE_TRUNC(DATE(completed_at), ISOWEEK)) AS n
      FROM t WHERE bugcheck_code IN (SELECT bugcheck_code FROM trend_codes)
      QUALIFY ROW_NUMBER() OVER (PARTITION BY bugcheck_code, DATE_TRUNC(DATE(completed_at), ISOWEEK) ORDER BY completed_at) = 1
    ) AS t GROUP BY t.bugcheck_code ORDER BY SUM(n) DESC) AS stop_code_trends,
  ARRAY(SELECT AS STRUCT FORMAT_DATE('%Y-%m-%d', DATE_TRUNC(DATE(completed_at), ISOWEEK)) AS w, COUNT(*) AS n FROM t GROUP BY 1 ORDER BY 1) AS weekly_totals,
  STRUCT(
    ARRAY(SELECT bugcheck_code FROM top_codes) AS codes,
    ARRAY(SELECT image_name FROM top_images) AS modules,
    ARRAY(SELECT AS STRUCT bugcheck_code AS c, image_name AS m, COUNT(*) AS n FROM t
      WHERE bugcheck_code IN (SELECT bugcheck_code FROM top_codes) AND image_name IN (SELECT image_name FROM top_images)
      GROUP BY 1, 2) AS cells
  ) AS code_module_matrix,
  ARRAY(SELECT AS STRUCT IFNULL(dump_type, 'unknown') AS k, COUNT(*) AS n,
    APPROX_QUANTILES(file_size_bytes, 100)[OFFSET(50)] AS median_bytes FROM t GROUP BY 1 ORDER BY n DESC) AS dump_types
)) AS payload;

-- 3. AI priors: per stop code and per driver ---------------------------------
CREATE OR REPLACE TABLE `project-bigfoot.bsod_stats.crash_priors` AS
WITH t AS (SELECT * FROM `project-bigfoot.bsod_corpus.job_facts`),
total AS (SELECT COUNT(*) AS n FROM t),
by_code AS (
  SELECT bugcheck_code AS key, COUNT(*) AS n,
    ANY_VALUE(bugcheck_name) AS name,
    ROUND(SAFE_DIVIDE(COUNTIF(ai_hardware_error), COUNTIF(ai_model IS NOT NULL)), 3) AS hardware_share,
    ROUND(SAFE_DIVIDE(COUNTIF(uptime_seconds < 60), COUNTIF(uptime_seconds IS NOT NULL)), 3) AS first_minute_share,
    APPROX_TOP_COUNT(image_name, 6) AS images,
    APPROX_TOP_COUNT(process_name, 4) AS processes,
    APPROX_TOP_COUNT(windows_release, 3) AS releases
  FROM t WHERE bugcheck_code IS NOT NULL GROUP BY 1 HAVING n >= 10
),
image_maker AS (
  SELECT driver AS key, manufacturer FROM (
    SELECT d.driver, d.manufacturer, COUNT(*) AS c
    FROM t, UNNEST(t.ai_culprit_drivers) d
    WHERE d.manufacturer != 'Unknown' AND d.driver IS NOT NULL
    GROUP BY 1, 2)
  QUALIFY ROW_NUMBER() OVER (PARTITION BY driver ORDER BY c DESC) = 1
),
by_image AS (
  SELECT image_name AS key, COUNT(*) AS n,
    APPROX_TOP_COUNT(bugcheck_code, 5) AS codes,
    APPROX_TOP_COUNT(image_version, 5) AS versions,
    ROUND(SAFE_DIVIDE(COUNTIF(ai_hardware_error), COUNTIF(ai_model IS NOT NULL)), 3) AS hardware_share
  FROM t WHERE image_name IS NOT NULL AND image_name != 'unknown_image' GROUP BY 1 HAVING n >= 10
)
SELECT 'bugcheck' AS kind, key, CURRENT_TIMESTAMP() AS generated_at, TO_JSON_STRING(STRUCT(
  n, ROUND(n / (SELECT n FROM total), 4) AS share_of_all, (SELECT n FROM total) AS corpus_size, name,
  hardware_share, first_minute_share,
  ARRAY(SELECT AS STRUCT i.value AS image, ROUND(i.count / n, 3) AS share FROM UNNEST(images) i WHERE i.value IS NOT NULL) AS top_modules,
  ARRAY(SELECT AS STRUCT p.value AS process, ROUND(p.count / n, 3) AS share FROM UNNEST(processes) p WHERE p.value IS NOT NULL) AS top_processes,
  ARRAY(SELECT AS STRUCT r.value AS release, ROUND(r.count / n, 3) AS share FROM UNNEST(releases) r) AS top_releases
)) AS payload FROM by_code
UNION ALL
SELECT 'image' AS kind, key, CURRENT_TIMESTAMP() AS generated_at, TO_JSON_STRING(STRUCT(
  n, (SELECT n FROM total) AS corpus_size, hardware_share,
  (SELECT im.manufacturer FROM image_maker im WHERE im.key = by_image.key) AS manufacturer,
  ARRAY(SELECT AS STRUCT c.value AS code, ROUND(c.count / n, 3) AS share FROM UNNEST(codes) c WHERE c.value IS NOT NULL) AS top_stop_codes,
  ARRAY(SELECT AS STRUCT v.value AS version, ROUND(v.count / n, 3) AS share FROM UNNEST(versions) v WHERE v.value IS NOT NULL) AS top_versions
)) AS payload FROM by_image;

-- 4. Publish to Cloud Storage (Cloud Run reads these files, never BigQuery) ----
EXPORT DATA OPTIONS (uri = 'gs://project-bigfoot-bsod-stats/insights/*.json', format = 'JSON', overwrite = true) AS
SELECT generated_at, payload FROM `project-bigfoot.bsod_stats.corpus_insights`;

EXPORT DATA OPTIONS (uri = 'gs://project-bigfoot-bsod-stats/priors/*.json', format = 'JSON', overwrite = true) AS
SELECT kind, key, payload FROM `project-bigfoot.bsod_stats.crash_priors`;

EXPORT DATA OPTIONS (uri = 'gs://project-bigfoot-bsod-stats/baseline/*.json', format = 'JSON', overwrite = true) AS
SELECT captured_at, raw FROM `project-bigfoot.bsod_stats.baseline` ORDER BY captured_at DESC LIMIT 1;
