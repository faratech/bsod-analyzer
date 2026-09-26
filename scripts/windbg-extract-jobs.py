# One-shot read-only extractor for crash-stats history.
# Runs ON ST-WDBGAPI-01 against S:\WinDbg-API\windbg_jobs.db (live service DB):
# opens SQLite in mode=ro so the running service is never blocked, streams
# completed jobs submitted before --before (the BigQuery stats cutover, so no
# analysis is counted twice), and emits one compact JSON line per job with just
# the aggregate facts (no user paths/names). Feed the output to
# scripts/import-windbg-history.mjs.
#
#   python windbg-extract-jobs.py --before 2026-09-26T03:39
import argparse
import json
import sqlite3

DB_PATH = r"S:\WinDbg-API\windbg_jobs.db"
OUT_PATH = r"C:\Users\windbg-api\stats_backfill.jsonl"

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", required=True, help="UTC cutoff YYYY-MM-DDTHH:MM (BigQuery stats cutover)")
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--out", default=OUT_PATH)
    options = parser.parse_args()
    cutoff = options.before
    conn = sqlite3.connect(f"file:{options.db}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only=1")
    cur = conn.cursor()
    query = (
        "SELECT submitted_at, dump_type, result FROM jobs "
        "WHERE status='complete' AND result IS NOT NULL AND submitted_at < ? "
        "ORDER BY submitted_at ASC"
    )
    written = skipped = 0
    with open(options.out, "w", encoding="utf-8") as out:
        cur.execute(query, (cutoff,))
        while True:
            rows = cur.fetchmany(200)
            if not rows:
                break
            for ts, dtype, result in rows:
                try:
                    parsed = json.loads(result)
                except (ValueError, TypeError):
                    skipped += 1
                    continue
                signal = parsed.get("ai_signal") or {}
                bugcheck = signal.get("bugcheck") or {}
                crash = signal.get("crash") or {}
                target = signal.get("target") or {}
                record = {
                    "ts": ts,
                    "dtype": dtype,
                    "code": bugcheck.get("code"),
                    "name": bugcheck.get("name"),
                    "bucket": crash.get("failureBucketId"),
                    "module": crash.get("imageName") or crash.get("moduleName"),
                    "os": target.get("os_version"),
                }
                out.write(json.dumps(record, separators=(",", ":")) + "\n")
                written += 1
    print(f"written={written} skipped={skipped} cutoff={cutoff}")

if __name__ == "__main__":
    main()
