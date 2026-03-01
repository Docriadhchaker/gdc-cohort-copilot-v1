# GDC Cohort Copilot (v1)

Create cohorts and run basic clinical summaries from the [NCI GDC API](https://api.gdc.cancer.gov).

**Constraints:** No Postgres, Docker, Drizzle, or ORM. Data is stored only as JSON files in the local `data/` folder (gitignored). All numbers come from real GDC API responses; no mock data.

## Setup

**Requirements:** Node.js 18+ and npm.

On **Windows PowerShell** (exact commands):

```powershell
cd gdc-cohort-copilot-v1
npm install
npm run dev
```

Then open **http://localhost:3000** in your browser. The API is available at the same host under `/api` (e.g. http://localhost:3000/api/profiles). Host is **localhost** only.

**Default ports:** UI = 3000, API = 3001. If the API port is already in use (EADDRINUSE), set a different one and restart:

```powershell
$env:API_PORT=3002; npm run dev
```

Then use http://localhost:3000 in the browser; the UI proxy will send `/api` requests to the chosen API port.

## Verify running

After `npm run dev`, you should see both processes and the Local URL:

- **Expected terminal output:**  
  `[vite]` lines with **Local: http://localhost:3000/** and `[api]` lines with **UI: http://localhost:3000** and **API: http://localhost:3001** (or your `API_PORT`). If either process exits, the other is killed and the script exits so the error is visible.

- **Check ports are LISTENING (PowerShell):**

```powershell
netstat -an | findstr "3000 3001"
```

You should see `LISTENING` for `[::1]:3000` and `[::1]:3001` (or `0.0.0.0:3000` / `0.0.0.0:3001`). If you only see SYN_SENT or nothing for 3000, Vite is not running.

- **Quick API tests:**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/health"
# Expect: ok = True

Invoke-RestMethod -Uri "http://localhost:3000/api/profiles"
# Expect: list of profiles (e.g. BRCA, LUAD)
```

If you get "connection refused", ensure `npm run dev` is still running and netstat shows both ports LISTENING.

## Usage

1. Open http://localhost:3000 in your browser.
2. Choose a profile (e.g. BRCA, LUAD, COAD); use the search box to filter by name or description.
3. Optionally set filters: **Stage (exact)** dropdown (from GDC), **Stage group** (I/II/III/IV), **Gender** (male/female).
4. Click **Create Cohort** → the app shows `n_cases` and the first 10 `case_ids`.
5. Click **Run Cohort Summary** → the app shows summary stats (n_cases, gender/stage distribution, missingness).

Cohort snapshots and summary outputs are stored as JSON files under `/data` (gitignored). No database.

### Stage filtering

Stage is no longer free text: the UI loads **stage options** from the API (GET /api/stage-options) for the selected profile and shows a dropdown of exact values (e.g. Stage IIA, Stage IIIB) with counts. Choosing **Stage group** (I/II/III/IV) expands to all matching GDC values for that group so that selecting "II" returns cohorts for Stage II, IIA, IIB, IIC instead of 0. Exact stage and stage group are mutually exclusive; exact stage takes precedence if both are sent.

## API

### GET /api/health

Returns `{ "ok": true }`. Use this to verify the API (and proxy) are up.

### GET /api/stage-options

Returns stage values and counts for a profile (from a GDC sample), for building stage dropdowns.

**Query:** `profileKey` (required) — e.g. `brca`, `luad`.

**Response:** `[{ "value": "Stage IIA", "count": 357 }, ...]` sorted by count descending.

**Example:**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/stage-options?profileKey=brca"
```

### GET /api/profiles

Returns the list of available profiles, sorted alphabetically by name (e.g. BLCA, BRCA, COAD, …).

**Example:**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/profiles"
```

### POST /api/cohorts

Creates a cohort from the GDC API and returns a snapshot (filters, `n_cases`, `case_ids`). Optionally filter by `stage`, `stageGroup`, and `gender`.

**Body:**

```json
{
  "profileKey": "brca",
  "filters": {
    "stage": "Stage IIA",
    "gender": "female"
  }
}
```

- `profileKey` is required and must match an existing profile id (e.g. `brca`, `luad` from GET /api/profiles). For backward compatibility, `profileId` is accepted as an alias for `profileKey`.
- **Stage filtering:** Use exact `stage` (e.g. `"Stage IIA"`) for a single value, or use `stageGroup` (`"I"`, `"II"`, `"III"`, `"IV"`) to match all stages in that group (e.g. II → Stage II, IIA, IIB, IIC). If both are provided, `stage` takes precedence. Stage options come from GDC (see GET /api/stage-options).

**Example:**

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/cohorts" -ContentType "application/json" -Body '{"profileKey":"brca"}'
```

With filters:

```powershell
$body = @{ profileKey = "luad"; filters = @{ gender = "male" } } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/api/cohorts" -Method Post -Body $body -ContentType "application/json"
```

**Response:** cohort object with `id`, `n_cases`, `case_ids`, etc. The snapshot is saved under `data/<id>.json`.

### POST /api/cohorts/:id/summary

Computes a cohort summary (n_cases, gender distribution, stage distribution if available, missingness) from GDC and returns it. Result is saved under `data/<id>_summary.json`.

**Example:**

```powershell
# Replace COHORT_ID with the id returned from POST /api/cohorts (e.g. cohort_1730123456789)
Invoke-RestMethod -Uri "http://localhost:3000/api/cohorts/COHORT_ID/summary" -Method Post
```

### POST /api/cohorts/:id/survival (Survival Pack)

Computes Kaplan-Meier overall survival (OS) for the cohort using GDC fields `diagnoses.days_to_death` and `diagnoses.days_to_last_follow_up`. Optionally stratify by `gender` or `stage` (log-rank p-value when exactly 2 groups). Result saved under `data/<id>_survival.json`.

**Body:** `{ "stratify_by": null | "gender" | "stage" }`

**Response:** `n_total`, `n_events`, `missingness`, `km_points` (array of `{ t, s }`), and if stratified: `groups` (each with `name`, `n`, `km_points`), `p_value`.

If fewer than 10% of cases have OS data, the API returns `400` with an error and missingness report (no synthetic results).

**Example:**

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/cohorts/COHORT_ID/survival" -Method Post -ContentType "application/json" -Body '{}'
$body = '{"stratify_by":"gender"}'; Invoke-RestMethod -Uri "http://localhost:3000/api/cohorts/COHORT_ID/survival" -Method Post -ContentType "application/json" -Body $body
```

## Exports

One-click exports for an existing cohort (no breaking changes to existing API).

### GET /api/cohorts/:id/export/case_ids.csv

Returns a CSV with header `case_id` and one row per case in the cohort. Open in Excel or use for downstream tools.

**Example (PowerShell; save to file):**

```powershell
$cohortId = "cohort_1730123456789"
Invoke-WebRequest -Uri "http://localhost:3000/api/cohorts/$cohortId/export/case_ids.csv" -OutFile "$cohortId_case_ids.csv"
```

### POST /api/cohorts/:id/export/files-manifest

Queries GDC for files belonging to the cohort’s case_ids and optional filters, then returns a TSV manifest (and saves it under `data/<cohort_id>_manifest.tsv`). Columns: `file_id`, `file_name`, `md5sum`, `file_size`, `data_type`, `experimental_strategy`, `cases.case_id`.

**Body:**

- `data_types` (required, array): e.g. `["Gene Expression Quantification", "Masked Somatic Mutation"]`
- `experimental_strategy` (optional, array): e.g. `["RNA-Seq", "WXS"]`
- `access` (optional): `"open"` or `"controlled"`

**Example (PowerShell; save TSV to file):**

```powershell
$cohortId = "cohort_1730123456789"
$body = @{ data_types = @("Gene Expression Quantification"); experimental_strategy = @("RNA-Seq") } | ConvertTo-Json
Invoke-WebRequest -Uri "http://localhost:3000/api/cohorts/$cohortId/export/files-manifest" -Method Post -Body $body -ContentType "application/json" -OutFile "$cohortId_manifest.tsv"
```

In the UI, use **Export case_ids CSV** and **Export files manifest** in the Cohort card; the manifest dialog lets you choose presets (RNA-seq, Somatic mutations, WXS BAM) and triggers a browser download.

## Report generator

Generate a research-use report (Markdown + printable HTML) for a cohort. The report includes only sections for which data exists: cohort definition, data quality (missingness), summary tables (gender, stage), survival stats (if run), files manifest (if exported), and a disclaimer.

- **GET /api/cohorts/:id/report.md** — builds the report from existing artifacts (cohort snapshot, summary, survival, manifest), saves to `data/<id>_report.md`, and returns the Markdown (download).
- **GET /api/cohorts/:id/report.html** — same content as printable HTML (open in new tab to print).

In the UI, click **Generate Report** in the Cohort card; after generation, use **Preview (HTML)** and **Download .md**.

## Project layout

- `server.js` – Express API and GDC client
- `profiles/` – `brca.json`, `luad.json` (profile definitions)
- `data/` – cohort snapshots, summary JSON, survival JSON, report .md, and export manifests (gitignored)
- `src/` – Vite + React UI
- `index.html`, `vite.config.js` – Vite entry and config (dev on port 3000, host localhost; `/api` proxied to backend)

## Errors

No mock data: every number comes from the GDC API. If a GDC request fails (network or API error), the API returns a `502` with a clear `error` and `message`. The UI shows that message in a red box.
