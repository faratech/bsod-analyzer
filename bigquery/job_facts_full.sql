-- One-off full rebuild of job_facts (the daily build is incremental). Scans the
-- whole corpus once (~10 GB); only needed after changing job_facts_since().
CREATE OR REPLACE TABLE `project-bigfoot.bsod_corpus.job_facts`
PARTITION BY DATE(completed_at)
CLUSTER BY bugcheck_code AS
SELECT * FROM `project-bigfoot.bsod_corpus.job_facts_since`(TIMESTAMP '2000-01-01');
