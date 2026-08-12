# Rank Tracker Data Contract

## Contents

- Input contract
- Preflight receipt
- Script commands
- Output layout
- CSV schemas
- Status and ranking semantics

## Input contract

`prepare-run` accepts a JSON object on stdin. It may contain `config_path`, explicit fields, or both. Explicit fields override matching values from the config file.

```json
{
  "config_path": "/absolute/or/relative/job.json",
  "asin": "B0XXXXXXXX",
  "marketplace": "US",
  "pages": 3,
  "keywords_file": "./keywords.txt",
  "output_dir": "./rank-data/B0XXXXXXXX-US",
  "browser_id": "optional-browser-id",
  "preflight": {}
}
```

Required resolved fields:

- `asin`: 10 letters/digits; normalized to uppercase.
- `marketplace`: non-empty; normalized to uppercase.
- `pages`: integer 1-10 with no default.
- `keywords_file`: UTF-8 text with one keyword per line.
- `output_dir`: explicit data-project directory.

Relative paths from `job.json` resolve against the config directory. Explicit relative paths resolve against the current working directory. `browser_id` is optional but, when present, must match the browser selected during preflight.

The keyword reader strips a UTF-8 BOM, trims lines, ignores blanks and `#` comments, preserves the first spelling of a keyword, deduplicates with NFKC + case-insensitive matching, and requires 1-50 final keywords.

## Preflight receipt

`prepare-run` requires `preflight` with:

- `mcp_ready=true`.
- `required_tools` containing all four SellerSpace tools.
- `action_id=amazon.search.keyword_rank`.
- `action_available=true` and `action_version>=5`; v5 supports the fetch-first `auto` mode used by this Skill.
- `browser_online=true` and a non-empty `browser_id`.
- `artifact_delivery_available=true` and `artifact_schema_version=1`, derived from the live `browser_list.taskDelivery` response.
- Optional `checked_at` and sanitized `browser_meta`.

The Skill must derive this receipt from live tool results. Missing or invalid receipts fail before reading the config/keyword file or creating `output_dir`.

## Script commands

All commands read the first non-empty compact JSON line from non-TTY stdin and emit one compact JSON object. Use a pipe/session with echo disabled; do not send pretty-printed multiline JSON or a PTY that echoes large browser results.

### `prepare-run`

Input: resolved user/config values plus `preflight`.

Output includes `run_id`, `output_dir`, `browser_id`, `action`, `outputs`, and an ordered `tasks` array. Each task contains `keyword_index`, `keyword`, exact Action `params` with `mode=auto`, `screenshot=false`, and `upload=true`, plus `result_delivery={"mode":"artifact","targetAsin":"<project ASIN>"}`. In `auto`, the v5+ plugin tries fetch first and may fall back to a background tab only when fetch is blocked, fails, or produces an unusable page. Each returned page's actual `fetch` or `tab` mode remains archived in `page_mode`.

### `record-result`

```json
{
  "output_dir": "/absolute/project",
  "run_id": "run-id",
  "keyword_index": 0,
  "attempts": [
    { "job_id": "job-1", "status": "failed", "error": { "code": "TIMEOUT", "message": "..." } },
    { "job_id": "job-2", "status": "completed" }
  ],
  "task": {
    "status": "completed",
    "jobId": "job-2",
    "finishedAt": "2026-08-11T08:10:00.000Z",
    "summary": {
      "resultCount": 96,
      "target": { "asin": "B0XXXXXXXX", "naturalRank": 18 }
    },
    "artifact": {
      "schemaVersion": 1,
      "id": "2026-08/artifact-id",
      "downloadUrl": "https://hub.example/artifacts/download?...",
      "sha256": "64 lowercase hex characters",
      "uncompressedSizeBytes": 12345
    }
  }
}
```

`task.status` is `completed` or `failed`. A failed task carries `error`. At most two browser attempts are accepted. A completed Artifact is downloaded with redirects disabled, limited to 64 MiB after decompression, checked against `uncompressedSizeBytes` and SHA-256, then parsed as JSON. Only HTTPS is accepted except HTTP loopback for local testing. Signed URLs are never written to run manifests; safe Artifact metadata is retained for audit. Recording the same keyword again replaces its staging result while the run is active.

The script still accepts an inline `task.result` for deterministic backward-compatible unit tests, but this Skill must never request or use inline delivery. If Artifact ingestion fails, `record-result` stores the keyword as `failed` with an `ARTIFACT_*` code and continues the run without resubmitting the browser task.

### `finalize-run`

```json
{
  "output_dir": "/absolute/project",
  "run_id": "run-id",
  "interrupted": false
}
```

`interrupted=true` or any pending keyword makes the run `incomplete`. Otherwise failures or blocked pages produce `completed_with_issues`; a clean run is `completed`. Repeated finalization is idempotent and rebuilds the report when needed.

### `render-report`

```json
{
  "output_dir": "/absolute/project",
  "asin": "B0OPTIONAL1"
}
```

Omit `asin` to rebuild the configured target report. A different ASIN must occur at least once in the archived full results.

## Output layout

```text
output_dir/
├── project.json
├── target-rank-history.csv
├── report.html
├── all-asins/YYYY-MM/<run_id>.csv
├── reports/<other_asin>.html
└── runs/<run_id>.json
```

`project.json` fixes one ASIN + marketplace identity per output directory. A run manifest stores the input snapshot, browser metadata, job IDs, attempts, keyword status, counts, and relative output paths. Temporary staging data lives below `runs/.staging/` and is removed only after successful finalization.

## CSV schemas

Both CSV types use UTF-8 BOM, CRLF rows, RFC-style quoting, and atomic replacement.

`target-rank-history.csv` contains one row per `run_id + keyword`:

```text
run_id,collected_at,marketplace,target_asin,keyword,pages_requested,
pages_completed,result_count,blocked,target_found,natural_found,natural_rank,
ad_found,best_ad_position,ad_types,ad_occurrence_count,best_overall_position,
status,error_code,error_message
```

`all-asins/YYYY-MM/<run_id>.csv` preserves every returned occurrence:

```text
run_id,collected_at,marketplace,keyword,page,page_mode,page_url,
position,natural_rank,asin,ad_type
```

## Status and ranking semantics

- `ok`: the ASIN appeared in any placement.
- `not_found`: a completed, non-blocked search did not contain the ASIN.
- `blocked`: the browser result reported `blocked=true`.
- `failed`: the terminal task failed.
- `not_executed`: the run ended before this keyword started.

Natural rank is the minimum numeric `naturalRank` for the ASIN. Advertising position is the minimum `rank` among rows with no `naturalRank` and a non-empty `adType`. `best_overall_position` is the minimum returned `rank` across all target occurrences. Missing ranks remain empty.

The HTML report embeds the complete sanitized ranking history needed for local interaction, and loads the official SellerSpace logo plus Tailwind CSS, Remix Icon, and ECharts from HTTPS CDN URLs. Opening the fully styled interactive chart therefore requires internet access; the embedded table and data remain readable when a CDN fails, with an explicit dependency warning.

The report compares each metric with the previous numeric observation for the same keyword. A positive delta means improvement because a smaller rank is better. Missing, failed, blocked, and unexecuted points remain chart gaps; ECharts uses `connectNulls=false` and an inverse rank axis so rank 1 stays at the top.
