#!/usr/bin/env python3
"""
Wiki Batch Ingest — Remote Content Mode

Ingests local markdown files into a remote Jelly Code wiki server
by sending file content via REST API (no filesystem access needed).

Uses single-file /api/wiki/ingest endpoint for reliability.

Usage:
    python wiki-batch-ingest-remote.py /path/to/docs --project-id my-project --url http://localhost:8095 --key your-api-key
    python wiki-batch-ingest-remote.py /path/to/docs --project-id my-project --batch-size 10 --pattern "**/*.md"
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

try:
    import httpx
except ImportError:
    print("httpx required: pip install httpx")
    sys.exit(1)


def find_files(directory: str, pattern: str = "**/*.md") -> list[str]:
    """Find all files matching glob pattern."""
    return sorted(str(p) for p in Path(directory).glob(pattern) if p.is_file())


def ingest_single(
    base_url: str,
    api_key: str,
    source_path: str,
    content: str,
    project_id: str,
) -> dict:
    """Send a single file to the wiki ingest endpoint."""
    resp = httpx.post(
        f"{base_url}/api/wiki/ingest",
        headers={"x-api-key": api_key, "Content-Type": "application/json"},
        json={"projectId": project_id, "source_path": source_path, "content": content},
        timeout=180,  # 3 min per file (LLM compilation is slow)
    )
    if resp.status_code != 200:
        try:
            detail = resp.json().get("error", resp.text[:200])
        except Exception:
            detail = resp.text[:200]
        return {"error": f"HTTP {resp.status_code}: {detail}"}
    return resp.json()


def main():
    parser = argparse.ArgumentParser(description="Batch ingest docs into remote Jelly Code wiki")
    parser.add_argument("directory", help="Directory containing markdown files")
    parser.add_argument("--url", default="http://localhost:8095", help="jelly-code server URL")
    parser.add_argument("--key", default="dev_key_1", help="API key")
    parser.add_argument("--project-id", required=True, help="Project ID for multi-tenant isolation")
    parser.add_argument("--pattern", default="**/*.md", help="Glob pattern for files")
    parser.add_argument("--skip-existing", action="store_true", help="Skip already-ingested files")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be ingested without doing it")
    args = parser.parse_args()

    # Find files
    files = find_files(args.directory, args.pattern)
    print(f"Found {len(files)} files matching '{args.pattern}' in {args.directory}")

    if not files:
        print("No files found. Exiting.")
        return

    # Check already ingested — compare by relative path
    if args.skip_existing:
        print("Skipping already-ingested check (use --skip-existing to enable)...")
        # skip-existing is unreliable due to path mismatch between client and server
        # so it's opt-in only

    # Dry run
    if args.dry_run:
        print(f"\nWould ingest {len(files)} files:")
        for f in files[:20]:
            print(f"  {os.path.relpath(f, args.directory)}")
        if len(files) > 20:
            print(f"  ... and {len(files) - 20} more")
        return

    # Single-file ingest (one request per file for reliability)
    total_files = len(files)
    total_created = 0
    total_updated = 0
    total_errors = 0
    error_files = []
    start_time = time.time()

    print(f"\nIngesting {total_files} files (single-file mode)...")

    for i, fpath in enumerate(files):
        rel_path = os.path.relpath(fpath, args.directory)

        try:
            content = Path(fpath).read_text(encoding="utf-8")
        except Exception as e:
            print(f"  [{i+1}/{total_files}] [READ ERROR] {rel_path}: {e}")
            total_errors += 1
            error_files.append(rel_path)
            continue

        try:
            result = ingest_single(args.url, args.key, rel_path, content, args.project_id)

            if "error" in result:
                print(f"  [{i+1}/{total_files}] [ERROR] {rel_path}: {result['error'][:120]}")
                total_errors += 1
                error_files.append(rel_path)
                continue

            # Async ingest response: {status, taskId, projectId, sourcePath, hint}
            created = result.get("entitiesCreated", 0)
            updated = result.get("entitiesUpdated", 0)
            total_created += created
            total_updated += updated

            elapsed = time.time() - start_time
            done = i + 1
            rate = done / elapsed if elapsed > 0 else 0
            eta = (total_files - done) / rate if rate > 0 else 0

            status = "OK"
            if created == 0 and updated == 0:
                status = "OK (0 entities)"

            print(f"  [{done}/{total_files}] {status}: {rel_path} "
                  f"(+{created} created, {updated} updated) | "
                  f"ETA: {eta:.0f}s ({rate:.2f} files/s)")

        except Exception as e:
            err_msg = str(e)[:120]
            print(f"  [{i+1}/{total_files}] [EXCEPTION] {rel_path}: {err_msg}")
            total_errors += 1
            error_files.append(rel_path)

    elapsed = time.time() - start_time
    print(f"\n{'='*60}")
    print(f"Ingest complete in {elapsed:.1f}s ({elapsed/60:.1f}min)")
    print(f"  Files processed: {total_files}")
    print(f"  Entities created: {total_created}")
    print(f"  Entities updated: {total_updated}")
    print(f"  Errors: {total_errors}")
    if error_files:
        print(f"\n  Failed files ({len(error_files)}):")
        for f in error_files[:20]:
            print(f"    - {f}")
        if len(error_files) > 20:
            print(f"    ... and {len(error_files) - 20} more")


if __name__ == "__main__":
    main()
