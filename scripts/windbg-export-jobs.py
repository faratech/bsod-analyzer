# Consistent, privacy-trimmed export of the WinDBG job history (analysis
# corpus + stats history). Runs ON ST-WDBGAPI-01 against the live DB:
# opens it read-only and copies inside a single read transaction, so the
# result is a consistent snapshot even while the service keeps writing
# (copying the .db file itself mid-write produces a torn database).
#
# Copies only the `jobs` table — never users, API keys, reset tokens or
# logs — and drops caller-identifying columns (api_key, callback_url,
# owner_user_id, server paths, commands, original file names).
#
#   python windbg-export-jobs.py --out C:\Users\Public\windbg_jobs_export.db
import argparse
import os
import sqlite3

DB_PATH = r"S:\WinDbg-API\windbg_jobs.db"
COLUMNS = [
    "id", "status", "submitted_at", "started_at", "completed_at", "mode",
    "file_size_bytes", "dump_type", "canonical_type", "detected_profile",
    "result", "result_pruned_at", "error", "error_category", "failure_reason",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--out", required=True)
    options = parser.parse_args()
    if os.path.exists(options.out):
        raise SystemExit(f"{options.out} already exists; remove it first")

    src = sqlite3.connect(f"file:{options.db}?mode=ro", uri=True)
    src.execute("PRAGMA query_only=1")
    available = {row[1] for row in src.execute("PRAGMA table_info(jobs)")}
    columns = [c for c in COLUMNS if c in available]

    dst = sqlite3.connect(options.out)
    dst.execute(f"CREATE TABLE jobs ({', '.join(columns)})")
    select = f"SELECT {', '.join(columns)} FROM jobs WHERE status IN ('complete', 'failed') ORDER BY submitted_at"
    insert = f"INSERT INTO jobs VALUES ({', '.join('?' for _ in columns)})"

    copied = 0
    src.execute("BEGIN")  # one read transaction = one consistent snapshot
    cursor = src.execute(select)
    while True:
        rows = cursor.fetchmany(200)
        if not rows:
            break
        dst.executemany(insert, rows)
        copied += len(rows)
        if copied % 10000 < 200:
            dst.commit()
            print(f"copied {copied} jobs...", flush=True)
    src.execute("COMMIT")
    dst.commit()

    check = dst.execute("PRAGMA integrity_check").fetchone()[0]
    count = dst.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    span = dst.execute("SELECT MIN(submitted_at), MAX(submitted_at) FROM jobs").fetchone()
    size = os.path.getsize(options.out)
    print(f"done: {count} jobs, {span[0]} .. {span[1]}, integrity={check}, {size / 1e9:.2f} GB -> {options.out}")


if __name__ == "__main__":
    main()
