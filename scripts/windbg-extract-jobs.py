# One-shot read-only extractor for crash-stats backfill.
# Runs ON ST-WDBGAPI-01 against S:\WinDbg-API\windbg_jobs.db (live service DB):
# opens SQLite in mode=ro so the running service is never blocked, streams only
# completed jobs older than the Upstash cache window (7 days), and emits one
# compact JSON line per job with just the aggregate facts (no user paths/names).
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone

DB_PATH = r"S:\WinDbg-API\windbg_jobs.db"
OUT_PATH = r"C:\Users\windbg-api\stats_backfill.jsonl"
DAYS_BACK = 7

def main():
    cutoff = (datetime.now(timezone.utc) - timedelta(days=DAYS_BACK)).strftime("%Y-%m-%dT%H:%M")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only=1")
    cur = conn.cursor()
    query = (
        "SELECT submitted_at, dump_type, result FROM jobs "
        "WHERE status='complete' AND result IS NOT NULL AND submitted_at < ? "
        "ORDER BY submitted_at ASC"
    )
    written = skipped = 0
    with open(OUT_PATH, "w", encoding="utf-8") as out:
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
