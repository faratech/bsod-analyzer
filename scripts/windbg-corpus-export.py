# Backfill export for the BigQuery WinDBG corpus (bsod_corpus.windbg_analyses).
# Runs ON ST-WDBGAPI-01 against the live DB: opens it read-only and reads inside
# one read transaction, so the export is a consistent snapshot while the service
# keeps writing. Writes gzipped NDJSON rows in exactly the shape
# server/windbgCorpus.js buildCorpusRow() streams live (ingest_source='backfill'),
# with the complete, unredacted job result. jobs.result may be zstd-compressed
# (BLOB); that needs Python 3.14+ (stdlib compression.zstd).
#
#   py -3.14 windbg-corpus-export.py --out S:\WinDbg-API\backup\corpus.ndjson.gz
#   bq load --source_format=NEWLINE_DELIMITED_JSON \
#     project-bigfoot:bsod_corpus.windbg_analyses corpus.ndjson.gz
#
# Load jobs take the JSON column as a nested object (streaming inserts take a
# string), so `result` is written as an object here. Duplicates of live rows are
# harmless: query bsod_corpus.windbg_analyses_latest.
import argparse
import datetime
import gzip
import json
import sqlite3

try:
    from compression import zstd
except ImportError:
    zstd = None

DB_PATH = r"S:\WinDbg-API\windbg_jobs.db"
TERMINAL = ("complete", "failed", "timed_out", "cancelled")
COLUMNS = [
    "id", "status", "mode", "dump_type", "canonical_type", "detected_profile",
    "variant_key", "file_size_bytes", "submitted_at", "started_at", "completed_at",
    "error", "error_category", "failure_reason", "result",
]


def text(value):
    return None if value is None or value == "" else str(value)


def iso(value):
    if not value:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=datetime.timezone.utc)
    return parsed.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def decode_result(raw):
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray, memoryview)):
        if zstd is None:
            raise SystemExit("jobs.result is zstd-compressed; run this with Python 3.14+")
        raw = zstd.decompress(bytes(raw)).decode("utf-8")
    try:
        value = json.loads(raw)
    except ValueError:
        return {"stdout": raw}
    return value if isinstance(value, dict) else {"stdout": raw}


def build_row(job, ingested_at):
    result = decode_result(job["result"])
    signal = (result or {}).get("ai_signal") or {}
    bugcheck = signal.get("bugcheck") or {}
    crash = signal.get("crash") or {}
    target = signal.get("target") or {}
    size = job["file_size_bytes"]
    return {
        "job_id": str(job["id"]),
        "ingest_source": "backfill",
        "ingested_at": ingested_at,
        "file_hash": None,
        "status": text(job["status"]),
        "mode": text(job["mode"]),
        "dump_type": text(job["dump_type"]),
        "canonical_type": text(job["canonical_type"]),
        "detected_profile": text(job["detected_profile"]),
        "variant_key": text(job["variant_key"]),
        "file_size_bytes": int(size) if isinstance(size, (int, float)) and size > 0 else None,
        "submitted_at": iso(job["submitted_at"]),
        "started_at": iso(job["started_at"]),
        "completed_at": iso(job["completed_at"]),
        "error": text(job["error"]),
        "error_category": text(job["error_category"]),
        "failure_reason": text(job["failure_reason"]),
        "bugcheck_code": text(bugcheck.get("code")),
        "bugcheck_name": text(bugcheck.get("name")),
        "failure_bucket": text(crash.get("failureBucketId")),
        "symbol_name": text(crash.get("symbolName")),
        "module_name": text(crash.get("moduleName")),
        "image_name": text(crash.get("imageName")),
        "image_version": text(crash.get("imageVersion")),
        "process_name": text(crash.get("processName")),
        "os_version": text(target.get("os_version")),
        "arch": text(target.get("arch")),
        "raw_output_pruned": bool((result or {}).get("raw_output_pruned") is True),
        "result": result,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DB_PATH)
    parser.add_argument("--out", required=True, help="gzipped NDJSON output path")
    parser.add_argument("--ids-out", help="also write the exported job ids, one per line")
    options = parser.parse_args()

    ingested_at = iso(datetime.datetime.now(datetime.timezone.utc).isoformat())
    conn = sqlite3.connect(f"file:{options.db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=1")
    available = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
    columns = [c if c in available else f"NULL AS {c}" for c in COLUMNS]
    placeholders = ", ".join("?" for _ in TERMINAL)
    query = (
        f"SELECT {', '.join(columns)} FROM jobs WHERE status IN ({placeholders}) "
        "ORDER BY completed_at"
    )

    written = 0
    ids = open(options.ids_out, "w", encoding="utf-8") if options.ids_out else None
    conn.execute("BEGIN")  # one read transaction = one consistent snapshot
    with gzip.open(options.out, "wt", encoding="utf-8", compresslevel=6) as out:
        cursor = conn.execute(query, TERMINAL)
        while True:
            rows = cursor.fetchmany(100)
            if not rows:
                break
            for job in rows:
                out.write(json.dumps(build_row(job, ingested_at), ensure_ascii=False, separators=(",", ":")))
                out.write("\n")
                if ids:
                    ids.write(f"{job['id']}\n")
                written += 1
            if written % 1000 < 100:
                print(f"exported {written} jobs...", flush=True)
    conn.execute("COMMIT")
    if ids:
        ids.close()
    print(f"done: {written} jobs -> {options.out}")


if __name__ == "__main__":
    main()
