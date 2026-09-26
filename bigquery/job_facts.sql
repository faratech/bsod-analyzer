-- One row per WinDBG job with the aggregate-safe facts the crash insights need
-- (no raw output, no paths). Rebuilt daily; the public insights aggregate this.
CREATE OR REPLACE TABLE `project-bigfoot.bsod_corpus.job_facts`
PARTITION BY DATE(completed_at)
CLUSTER BY bugcheck_code AS
WITH w AS (
  SELECT
    job_id, submitted_at, started_at, completed_at, dump_type, file_size_bytes,
    bugcheck_code, bugcheck_name, failure_bucket, module_name, image_name, image_version, process_name,
    os_version, arch,
    JSON_VALUE(result, '$.ai_signal.target.session_time') AS session_time,
    JSON_VALUE(result, '$.ai_signal.target.system_uptime') AS system_uptime,
    JSON_VALUE(result, '$.ai_signal.target.product') AS product,
    SAFE_CAST(JSON_VALUE(result, '$.ai_signal.target.processor_count') AS INT64) AS processor_count,
    ARRAY_LENGTH(JSON_QUERY_ARRAY(result, '$.ai_signal.stackFrames')) AS stack_depth
  FROM `project-bigfoot.bsod_corpus.windbg_analyses_latest`
  WHERE status = 'complete'
),
a AS (
  SELECT
    job_id,
    JSON_VALUE(report, '$.culprit') AS ai_culprit,
    SAFE.BOOL(report.hardwareError.isHardwareError) AS ai_hardware_error,
    JSON_VALUE(report, '$.hardwareError.errorType') AS ai_hardware_type,
    JSON_VALUE(report, '$.hardwareError.component') AS ai_hardware_component,
    ARRAY(
      SELECT AS STRUCT
        LOWER(JSON_VALUE(d, '$.driverName')) AS driver,
        LOWER(JSON_VALUE(d, '$.category')) AS category,
        JSON_VALUE(d, '$.manufacturer') AS manufacturer
      FROM UNNEST(JSON_QUERY_ARRAY(report, '$.driverWarnings')) AS d
      WHERE SAFE.BOOL(d.isAssociatedWithBugCheck)
    ) AS ai_culprit_drivers,
    model AS ai_model
  FROM `project-bigfoot.bsod_corpus.ai_reports_latest`
  WHERE job_id IS NOT NULL
  QUALIFY ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY (origin != 'regenerated') DESC, created_at DESC) = 1
)
SELECT
  w.job_id, w.submitted_at, w.completed_at, w.dump_type, w.file_size_bytes,
  TIMESTAMP_DIFF(w.completed_at, w.started_at, SECOND) AS analysis_seconds,
  w.bugcheck_code, w.bugcheck_name, w.failure_bucket, w.module_name,
  LOWER(w.image_name) AS image_name, w.image_version, LOWER(w.process_name) AS process_name,
  w.arch, w.processor_count, w.stack_depth,
  SAFE_CAST(REGEXP_EXTRACT(w.os_version, r'Version (\d+)') AS INT64) AS os_build,
  CASE
    WHEN REGEXP_CONTAINS(IFNULL(w.product, ''), r'(?i)LanManNt|ServerNt') THEN 'Server'
    WHEN w.product IS NULL THEN NULL ELSE 'Workstation' END AS product_type,
  SUBSTR(w.session_time, 1, 3) AS crash_weekday,
  SAFE_CAST(REGEXP_EXTRACT(w.session_time, r' (\d{1,2}):\d{2}:\d{2}') AS INT64) AS crash_local_hour,
  REGEXP_EXTRACT(w.session_time, r'\(UTC ([+-] ?\d{1,2}:\d{2})\)') AS utc_offset,
  SAFE_CAST(REGEXP_EXTRACT(w.system_uptime, r'^(\d+) days') AS INT64) * 86400
    + SAFE_CAST(REGEXP_EXTRACT(w.system_uptime, r'days (\d+):') AS INT64) * 3600
    + SAFE_CAST(REGEXP_EXTRACT(w.system_uptime, r'days \d+:(\d+):') AS INT64) * 60
    + SAFE_CAST(REGEXP_EXTRACT(w.system_uptime, r'days \d+:\d+:(\d+)') AS INT64) AS uptime_seconds,
  CASE
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(w.image_name, '')), r'^(nvlddmkm|nvkflt|nvhda)') THEN 'NVIDIA'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(w.image_name, '')), r'^(amdkmdag|atikmdag|atikmpag|amdkmpfd)') THEN 'AMD'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(w.image_name, '')), r'^(igdkmd|igfx|intelppm)') THEN 'Intel'
    WHEN REGEXP_CONTAINS(LOWER(IFNULL(w.image_name, '')), r'^(dxgkrnl|dxgmms|watchdog)') THEN 'Microsoft graphics stack'
    ELSE NULL END AS gpu_stack,
  a.ai_culprit, a.ai_hardware_error, a.ai_hardware_type, a.ai_hardware_component, a.ai_culprit_drivers, a.ai_model
FROM w LEFT JOIN a USING (job_id);
