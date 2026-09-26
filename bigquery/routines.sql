-- Persistent routines for the crash-insights pipeline (run once, and again
-- whenever this file changes):
--   bq query --use_legacy_sql=false --location=us-east1 < bigquery/routines.sql
-- job_facts_since()/ai_facts_since() filter on the tables' partition columns,
-- so the daily incremental build only scans recent partitions.

CREATE OR REPLACE FUNCTION `project-bigfoot.bsod_corpus.norm_manufacturer`(m STRING) AS (
  CASE
    WHEN m IS NULL OR REGEXP_CONTAINS(LOWER(TRIM(m)), r'^not |not (identified|specified|determined|established|stated|provided|confirmed)|unknown|unidentified|undetermined|unclear|^n/?a$|^none|^unspecified') THEN 'Unknown'
    WHEN REGEXP_CONTAINS(LOWER(m), r'nvidia') THEN 'NVIDIA'
    WHEN REGEXP_CONTAINS(LOWER(m), r'\bamd\b|advanced micro|\bati\b') THEN 'AMD'
    WHEN REGEXP_CONTAINS(LOWER(m), r'intel') THEN 'Intel'
    WHEN REGEXP_CONTAINS(LOWER(m), r'microsoft') THEN 'Microsoft'
    WHEN REGEXP_CONTAINS(LOWER(m), r'realtek') THEN 'Realtek'
    WHEN REGEXP_CONTAINS(LOWER(m), r'qualcomm|killer|rivet') THEN 'Qualcomm / Killer'
    WHEN REGEXP_CONTAINS(LOWER(m), r'mediatek') THEN 'MediaTek'
    WHEN REGEXP_CONTAINS(LOWER(m), r'broadcom') THEN 'Broadcom'
    WHEN REGEXP_CONTAINS(LOWER(m), r'vmware') THEN 'VMware'
    WHEN REGEXP_CONTAINS(LOWER(m), r'oracle|virtualbox') THEN 'Oracle (VirtualBox)'
    WHEN REGEXP_CONTAINS(LOWER(m), r'logitech') THEN 'Logitech'
    WHEN REGEXP_CONTAINS(LOWER(m), r'corsair') THEN 'Corsair'
    WHEN REGEXP_CONTAINS(LOWER(m), r'razer') THEN 'Razer'
    WHEN REGEXP_CONTAINS(LOWER(m), r'asus|asustek') THEN 'ASUS'
    WHEN REGEXP_CONTAINS(LOWER(m), r'msi|micro-star') THEN 'MSI'
    WHEN REGEXP_CONTAINS(LOWER(m), r'gigabyte') THEN 'Gigabyte'
    WHEN REGEXP_CONTAINS(LOWER(m), r'riot|vanguard') THEN 'Riot (Vanguard)'
    WHEN REGEXP_CONTAINS(LOWER(m), r'battleye') THEN 'BattlEye'
    WHEN REGEXP_CONTAINS(LOWER(m), r'easy ?anti|epic') THEN 'Epic (EasyAntiCheat)'
    ELSE TRIM(SPLIT(m, '(')[OFFSET(0)])
  END
);

CREATE OR REPLACE FUNCTION `project-bigfoot.bsod_corpus.hardware_bucket`(t STRING, c STRING) AS (
  CASE
    WHEN REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(t, ''), ' ', IFNULL(c, ''))), r'memory|\bram\b|one-bit|bit flip|corrupted page|page.table|dimm') THEN 'Memory (RAM)'
    WHEN REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(t, ''), ' ', IFNULL(c, ''))), r'whea|machine.check|\bmce\b|processor|\bcpu\b|cache') THEN 'CPU machine check (WHEA)'
    WHEN REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(t, ''), ' ', IFNULL(c, ''))), r'\bnmi\b') THEN 'NMI hardware failure'
    WHEN REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(t, ''), ' ', IFNULL(c, ''))), r'disk|storage|nvme|ssd|sata') THEN 'Storage'
    WHEN REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(t, ''), ' ', IFNULL(c, ''))), r'gpu|graphics|video') THEN 'GPU'
    WHEN REGEXP_CONTAINS(LOWER(CONCAT(IFNULL(t, ''), ' ', IFNULL(c, ''))), r'pci|bus') THEN 'PCIe / bus'
    ELSE 'Other hardware'
  END
);

CREATE OR REPLACE FUNCTION `project-bigfoot.bsod_corpus.windows_release`(build INT64, product STRING) AS (
  CASE
    WHEN build IS NULL THEN 'Unknown'
    WHEN product = 'Server' AND build >= 26100 THEN 'Windows Server 2025'
    WHEN product = 'Server' AND build = 20348 THEN 'Windows Server 2022'
    WHEN product = 'Server' AND build = 17763 THEN 'Windows Server 2019'
    WHEN product = 'Server' THEN 'Windows Server (older)'
    WHEN build > 26200 THEN 'Windows 11 Insider'
    WHEN build = 26200 THEN 'Windows 11 25H2'
    WHEN build = 26100 THEN 'Windows 11 24H2'
    WHEN build IN (22621, 22631) THEN 'Windows 11 22H2/23H2'
    WHEN build = 22000 THEN 'Windows 11 21H2'
    WHEN build = 20348 THEN 'Windows Server 2022'
    WHEN build BETWEEN 19041 AND 19045 THEN 'Windows 10 20H1-22H2'
    WHEN build = 17763 THEN 'Windows 10 1809 / Server 2019'
    WHEN build BETWEEN 10240 AND 19000 THEN 'Windows 10 (older)'
    WHEN build IN (9200, 9600) THEN 'Windows 8 / 8.1'
    WHEN build IN (7600, 7601) THEN 'Windows 7'
    ELSE 'Other'
  END
);


CREATE OR REPLACE TABLE FUNCTION `project-bigfoot.bsod_corpus.ai_facts_since`(since TIMESTAMP) AS (
  SELECT
    job_id,
    origin AS ai_origin,
    JSON_VALUE(report, '$.culprit') AS ai_culprit,
    SAFE.BOOL(report.hardwareError.isHardwareError) AS ai_hardware_error,
    IF(SAFE.BOOL(report.hardwareError.isHardwareError),
       `project-bigfoot.bsod_corpus.hardware_bucket`(JSON_VALUE(report, '$.hardwareError.errorType'), JSON_VALUE(report, '$.hardwareError.component')),
       NULL) AS ai_hardware_bucket,
    ARRAY(
      SELECT AS STRUCT
        LOWER(JSON_VALUE(d, '$.driverName')) AS driver,
        LOWER(JSON_VALUE(d, '$.category')) AS category,
        `project-bigfoot.bsod_corpus.norm_manufacturer`(JSON_VALUE(d, '$.manufacturer')) AS manufacturer
      FROM UNNEST(JSON_QUERY_ARRAY(report, '$.driverWarnings')) AS d
      WHERE SAFE.BOOL(d.isAssociatedWithBugCheck)
    ) AS ai_culprit_drivers,
    model AS ai_model
  FROM `project-bigfoot.bsod_corpus.ai_reports`
  WHERE created_at >= since AND job_id IS NOT NULL
  -- live reports win over regenerated ones; then the newest
  QUALIFY ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY (origin != 'regenerated') DESC, created_at DESC) = 1
);

CREATE OR REPLACE TABLE FUNCTION `project-bigfoot.bsod_corpus.job_facts_since`(since TIMESTAMP) AS (
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
    FROM `project-bigfoot.bsod_corpus.windbg_analyses`
    WHERE completed_at >= since AND status = 'complete'
    QUALIFY ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY ingested_at DESC) = 1
  ),
  f AS (
    SELECT
      w.*,
      SAFE_CAST(REGEXP_EXTRACT(w.os_version, r'Version (\d+)') AS INT64) AS os_build,
      CASE WHEN w.product IS NULL THEN NULL
           WHEN REGEXP_CONTAINS(w.product, r'(?i)LanManNt|ServerNt') THEN 'Server' ELSE 'Workstation' END AS product_type,
      SUBSTR(w.session_time, 1, 3) AS local_weekday,
      SAFE_CAST(REGEXP_EXTRACT(w.session_time, r' (\d{1,2}):\d{2}:\d{2}') AS INT64) AS local_hour,
      SAFE_CAST(REPLACE(REGEXP_EXTRACT(w.session_time, r'\(UTC ([+-] ?\d{1,2}):\d{2}\)'), ' ', '') AS INT64) AS utc_offset_hours,
      SAFE_CAST(REGEXP_EXTRACT(w.system_uptime, r'^(\d+) days') AS INT64) * 86400
        + SAFE_CAST(REGEXP_EXTRACT(w.system_uptime, r'days (\d+):') AS INT64) * 3600
        + SAFE_CAST(REGEXP_EXTRACT(w.system_uptime, r'days \d+:(\d+):') AS INT64) * 60
        + SAFE_CAST(REGEXP_EXTRACT(w.system_uptime, r'days \d+:\d+:(\d+)') AS INT64) AS uptime_seconds
    FROM w
  )
  SELECT
    f.job_id, f.submitted_at, f.completed_at, f.dump_type, f.file_size_bytes,
    TIMESTAMP_DIFF(f.completed_at, f.started_at, SECOND) AS analysis_seconds,
    f.bugcheck_code, f.bugcheck_name, f.failure_bucket, LOWER(f.module_name) AS module_name,
    LOWER(f.image_name) AS image_name, f.image_version, LOWER(f.process_name) AS process_name,
    f.arch, f.processor_count, f.stack_depth, f.os_build, f.product_type,
    `project-bigfoot.bsod_corpus.windows_release`(f.os_build, f.product_type) AS windows_release,
    f.uptime_seconds,
    MOD(MOD(DIV(STRPOS('MonTueWedThuFriSatSun', f.local_weekday) - 1, 3)
          + DIV(f.local_hour - f.utc_offset_hours + 48, 24) - 2, 7) + 7, 7) AS crash_utc_weekday,
    MOD(f.local_hour - f.utc_offset_hours + 48, 24) AS crash_utc_hour,
    CASE
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(f.image_name, '')), r'^(nvlddmkm|nvkflt|nvhda)') THEN 'NVIDIA'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(f.image_name, '')), r'^(amdkmdag|atikmdag|atikmpag|amdkmpfd)') THEN 'AMD'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(f.image_name, '')), r'^(igdkmd|igfx)') THEN 'Intel'
      WHEN REGEXP_CONTAINS(LOWER(IFNULL(f.image_name, '')), r'^(dxgkrnl|dxgmms|watchdog)') THEN 'Microsoft graphics stack'
      ELSE NULL END AS gpu_stack,
    a.ai_origin, a.ai_culprit, a.ai_hardware_error, a.ai_hardware_bucket, a.ai_culprit_drivers, a.ai_model
  FROM f LEFT JOIN `project-bigfoot.bsod_corpus.ai_facts_since`(TIMESTAMP_SUB(since, INTERVAL 1 DAY)) a USING (job_id)
);
