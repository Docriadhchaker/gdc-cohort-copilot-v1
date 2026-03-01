import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GDC_BASE = 'https://api.gdc.cancer.gov';
const API_PORT = Number(process.env.API_PORT || 3001);
const DATA_DIR = path.join(__dirname, 'data');
const PROFILES_DIR = path.join(__dirname, 'profiles');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const app = express();
app.use(cors());
app.use(express.json());

// --- Health ---
app.get('/api/health', (req, res) => res.json({ ok: true }));

// --- Helpers ---
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function listProfiles() {
  const files = fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const p = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8'));
    return p;
  });
}

function loadProfile(profileId) {
  const p = path.join(PROFILES_DIR, `${profileId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function gdcRequest(endpoint, options = {}) {
  const url = `${GDC_BASE}${endpoint}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GDC API error (${res.status}): ${text || res.statusText}`);
  }
  return res.json();
}

async function gdcRequestText(endpoint, options = {}) {
  const url = `${GDC_BASE}${endpoint}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GDC API error (${res.status}): ${text || res.statusText}`);
  }
  return res.text();
}

/** Canonical stage: pathologic → clinical → tumor; first non-missing across diagnoses. */
function getCanonicalStage(hit) {
  const list = hit.diagnoses || [];
  const order = ['ajcc_pathologic_stage', 'ajcc_clinical_stage', 'tumor_stage'];
  const sourceByKey = { ajcc_pathologic_stage: 'pathologic', ajcc_clinical_stage: 'clinical', tumor_stage: 'tumor' };
  for (const d of list) {
    for (const key of order) {
      const v = d[key];
      if (v != null && v !== '') {
        const s = (typeof v === 'string' ? v.trim() : String(v)).trim();
        if (s) return { stage: s, source: sourceByKey[key] };
      }
    }
  }
  return { stage: '(missing)', source: 'missing' };
}

function buildCasesFilter(projectId, filters = {}, stageValues = null) {
  const content = [{ op: 'in', content: { field: 'project.project_id', value: [projectId] } }];
  if (filters.gender) {
    content.push({
      op: '=',
      content: { field: 'demographic.gender', value: [String(filters.gender).toLowerCase()] },
    });
  }
  const stageList = stageValues && stageValues.length > 0
    ? stageValues
    : (filters.stage ? [String(filters.stage).trim()] : null);
  if (stageList && stageList.length > 0) {
    content.push({ op: 'in', content: { field: 'diagnoses.ajcc_pathologic_stage', value: stageList } });
  }
  return { op: 'and', content };
}

function valuesForStageGroup(options, group) {
  const out = [];
  for (const o of options || []) {
    const v = o && o.value ? String(o.value).trim() : '';
    if (!v) continue;
    if (group === 'I' && v.startsWith('Stage I') && !v.startsWith('Stage II')) out.push(v);
    else if (group === 'II' && v.startsWith('Stage II') && !v.startsWith('Stage III')) out.push(v);
    else if (group === 'III' && v.startsWith('Stage III') && !v.startsWith('Stage IV')) out.push(v);
    else if (group === 'IV' && v.startsWith('Stage IV')) out.push(v);
  }
  return [...new Set(out)];
}

function firstNonNull(list, key) {
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    const v = item?.[key];
    if (v != null && v !== '') {
      const s = typeof v === 'string' ? v.trim() : v;
      if (s !== '') return s;
    }
  }
  return undefined;
}

function toDays(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Extract OS time and event from a case hit. Returns { time, event, vital_status, hasDaysToDeath, hasDaysToFollowUp }; time is null when excluded (no valid days). */
function getOSFromHit(hit) {
  const vitalStatusRaw = (hit.demographic?.vital_status ?? firstNonNull(hit.diagnoses || [], 'vital_status'));
  const vital_status = typeof vitalStatusRaw === 'string' ? vitalStatusRaw.trim() : (vitalStatusRaw ?? '');
  const daysDeathRaw = firstNonNull(hit.diagnoses || [], 'days_to_death') ?? hit.demographic?.days_to_death;
  const daysFollowUpRaw = firstNonNull(hit.diagnoses || [], 'days_to_last_follow_up') ?? hit.demographic?.days_to_last_follow_up;
  const days_to_death = toDays(daysDeathRaw);
  const days_to_last_follow_up = toDays(daysFollowUpRaw);
  const hasDaysToDeath = days_to_death != null;
  const hasDaysToFollowUp = days_to_last_follow_up != null;
  const time = days_to_death != null ? days_to_death : days_to_last_follow_up;
  const event = (vital_status === 'Dead') || hasDaysToDeath ? 1 : 0;
  return { time, event, vital_status, hasDaysToDeath, hasDaysToFollowUp };
}

/** Kaplan-Meier: input array of { time, event }. Returns sorted km_points [{ t, s }] with (0,1) first. When all censored, appends (max_time, 1) so the curve is a flat line. */
function kaplanMeier(rows) {
  const sorted = [...rows].filter((r) => r != null && Number.isFinite(r.time) && r.time >= 0).sort((a, b) => a.time - b.time);
  if (sorted.length === 0) return [];
  const points = [{ t: 0, s: 1 }];
  let s = 1;
  const times = sorted.map((r) => r.time);
  const events = sorted.map((r) => r.event);
  const uniqueTimes = [...new Set(times)].sort((a, b) => a - b);
  for (const t of uniqueTimes) {
    const atRisk = times.filter((ti) => ti >= t).length;
    const deaths = times.map((ti, i) => (ti === t && events[i] === 1 ? 1 : 0)).reduce((a, b) => a + b, 0);
    if (atRisk > 0 && deaths > 0) {
      s *= 1 - deaths / atRisk;
      points.push({ t, s });
    }
  }
  const maxTime = Math.max(...rows.map((r) => r.time));
  if (rows.length > 0 && points.length === 1) points.push({ t: maxTime, s: 1 });
  return points;
}

/** Log-rank p-value for two groups. rows: [{ time, event, group }]. group values 0 and 1. */
function logRankPValue(rows) {
  const g0 = rows.filter((r) => r.group === 0);
  const g1 = rows.filter((r) => r.group === 1);
  if (g0.length === 0 || g1.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const uniqueEventTimes = [...new Set(sorted.filter((r) => r.event === 1).map((r) => r.time))].sort((a, b) => a - b);
  let O1 = 0;
  let E1 = 0;
  let V = 0;
  for (const t of uniqueEventTimes) {
    const n1 = g0.filter((r) => r.time >= t).length;
    const n2 = g1.filter((r) => r.time >= t).length;
    const d = sorted.filter((r) => r.time === t && r.event === 1).length;
    const n = n1 + n2;
    if (n <= 0 || d <= 0) continue;
    O1 += sorted.filter((r) => r.group === 0 && r.time === t && r.event === 1).length;
    E1 += (n1 * d) / n;
    if (n > 1) V += (n1 * n2 * d * (n - d)) / (n * n * (n - 1));
  }
  if (V <= 0) return null;
  const chi2 = (O1 - E1) ** 2 / V;
  const p = 1 - chi2CDF(chi2, 1);
  return p;
}

function chi2CDF(x, df) {
  if (x <= 0) return 0;
  if (df === 1) {
    const z = Math.sqrt(x);
    return 2 * normalCDF(z) - 1;
  }
  return Math.max(0, Math.min(1, 1 - Math.exp(-x / 2)));
}

function normalCDF(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}


async function getStageOptions(profileKey) {
  const profile = loadProfile(profileKey);
  if (!profile) return [];
  const body = {
    filters: { op: 'in', content: { field: 'project.project_id', value: [profile.gdc_project_id] } },
    format: 'JSON',
    expand: 'diagnoses',
    fields: 'diagnoses.ajcc_pathologic_stage,diagnoses.tumor_stage,diagnoses.ajcc_clinical_stage',
    size: 2000,
    from: 0,
  };
  const data = await gdcRequest('/cases', { method: 'POST', body });
  const hits = data?.data?.hits ?? [];
  const countByValue = new Map();
  for (const h of hits) {
    const { stage } = getCanonicalStage(h);
    if (stage) countByValue.set(stage, (countByValue.get(stage) || 0) + 1);
  }
  return Array.from(countByValue.entries())
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => (b.count - a.count));
}

// --- API ---

// GET /api/profiles
app.get('/api/profiles', (req, res) => {
  try {
    const profiles = listProfiles().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json(profiles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stage-options?profileKey=brca|luad
app.get('/api/stage-options', async (req, res) => {
  try {
    const profileKey = req.query.profileKey;
    if (!profileKey || typeof profileKey !== 'string') {
      return res.status(400).json({ error: 'profileKey query is required' });
    }
    const profile = loadProfile(profileKey.trim());
    if (!profile) {
      return res.status(400).json({ error: `Unknown profile: ${profileKey}` });
    }
    const options = await getStageOptions(profileKey.trim());
    res.json(options);
  } catch (err) {
    console.error('GET /api/stage-options', err);
    res.status(502).json({ error: 'GDC request failed', message: err.message });
  }
});

// POST /api/cohorts — create cohort from GDC, save snapshot, return snapshot with case_ids
app.post('/api/cohorts', async (req, res) => {
  try {
    const body = req.body || {};
    const profileKey = body.profileKey ?? body.profileId;
    if (!profileKey || typeof profileKey !== 'string') {
      return res.status(400).json({ error: 'profileKey is required' });
    }
    const profile = loadProfile(profileKey.trim());
    if (!profile) {
      return res.status(400).json({ error: `Unknown profile: ${profileKey}` });
    }

    const { filters = {} } = body;
    let stageValues = null;
    if (!filters.stage && filters.stageGroup && ['I', 'II', 'III', 'IV'].includes(String(filters.stageGroup).trim())) {
      const options = await getStageOptions(profileKey.trim());
      stageValues = valuesForStageGroup(options, String(filters.stageGroup).trim());
    }
    const gdcFilter = buildCasesFilter(profile.gdc_project_id, filters, stageValues);
    const gdcBody = {
      filters: gdcFilter,
      format: 'JSON',
      fields: 'case_id,submitter_id',
      size: 10000,
      from: 0,
    };

    const data = await gdcRequest('/cases', { method: 'POST', body: gdcBody });
    const hits = data?.data?.hits ?? [];
    const total = data?.data?.pagination?.total ?? hits.length;
    const caseIds = hits.map((h) => h.case_id ?? h.id).filter(Boolean);

    const snapshot = {
      id: `cohort_${Date.now()}`,
      profileId: profile.id,
      profileName: profile.name,
      gdc_project_id: profile.gdc_project_id,
      filters: { ...filters },
      n_cases: total,
      case_ids: caseIds,
      created_at: new Date().toISOString(),
    };

    ensureDataDir();
    const snapshotPath = path.join(DATA_DIR, `${snapshot.id}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

    res.json(snapshot);
  } catch (err) {
    console.error('POST /api/cohorts', err);
    res.status(502).json({
      error: 'GDC request failed',
      message: err.message,
    });
  }
});

// POST /api/cohorts/:id/summary — compute summary from GDC for saved cohort case_ids
app.post('/api/cohorts/:id/summary', async (req, res) => {
  try {
    const { id } = req.params;
    const snapshotPath = path.join(DATA_DIR, `${id}.json`);
    if (!fs.existsSync(snapshotPath)) {
      return res.status(404).json({ error: `Cohort not found: ${id}` });
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const caseIds = snapshot.case_ids || [];
    if (caseIds.length === 0) {
      const summary = {
        cohort_id: id,
        n_cases: 0,
        gender: {},
        stage: {},
        missingness: { gender: 0, stage: 0 },
        stage_source_counts: { pathologic: 0, clinical: 0, tumor: 0, missing: 0 },
      };
      const outPath = path.join(DATA_DIR, `${id}_summary.json`);
      fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
      return res.json(summary);
    }

    const body = {
      filters: {
        op: 'in',
        content: { field: 'case_id', value: caseIds },
      },
      format: 'JSON',
      expand: 'demographic,diagnoses',
      fields: 'case_id,demographic.gender,diagnoses.ajcc_pathologic_stage,diagnoses.tumor_stage,diagnoses.ajcc_clinical_stage',
      size: Math.min(caseIds.length, 10000),
      from: 0,
    };

    const data = await gdcRequest('/cases', { method: 'POST', body });
    const hits = data?.data?.hits ?? [];

    const genderCounts = {};
    const stageCounts = {};
    const stageSourceCounts = { pathologic: 0, clinical: 0, tumor: 0, missing: 0 };
    let missingGender = 0;
    let missingStage = 0;

    for (const h of hits) {
      const g = h.demographic?.gender ?? (h.gender ?? '');
      const { stage, source } = getCanonicalStage(h);
      if (!g || g === '') missingGender++;
      else genderCounts[g] = (genderCounts[g] || 0) + 1;
      if (source) stageSourceCounts[source] = (stageSourceCounts[source] || 0) + 1;
      if (!stage || stage === '(missing)') missingStage++;
      else stageCounts[stage] = (stageCounts[stage] || 0) + 1;
    }

    const summary = {
      cohort_id: id,
      n_cases: hits.length,
      gender: genderCounts,
      stage: Object.keys(stageCounts).length ? stageCounts : undefined,
      missingness: {
        gender: missingGender,
        stage: missingStage,
      },
      stage_source_counts: stageSourceCounts,
    };

    const outPath = path.join(DATA_DIR, `${id}_summary.json`);
    fs.writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf8');
    res.json(summary);
  } catch (err) {
    console.error('POST /api/cohorts/:id/summary', err);
    res.status(502).json({
      error: 'GDC request failed',
      message: err.message,
    });
  }
});

// GET /api/cohorts/:id/export/case_ids.csv
app.get('/api/cohorts/:id/export/case_ids.csv', (req, res) => {
  try {
    const { id } = req.params;
    const snapshotPath = path.join(DATA_DIR, `${id}.json`);
    if (!fs.existsSync(snapshotPath)) {
      return res.status(404).json({ error: `Cohort not found: ${id}` });
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const caseIds = snapshot.case_ids || [];
    const csv = 'case_id\n' + caseIds.map((c) => String(c)).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${id}_case_ids.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('GET /api/cohorts/:id/export/case_ids.csv', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cohorts/:id/export/files-manifest
app.post('/api/cohorts/:id/export/files-manifest', async (req, res) => {
  try {
    const { id } = req.params;
    const snapshotPath = path.join(DATA_DIR, `${id}.json`);
    if (!fs.existsSync(snapshotPath)) {
      return res.status(404).json({ error: `Cohort not found: ${id}` });
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const caseIds = snapshot.case_ids || [];
    if (caseIds.length === 0) {
      const empty = 'file_id\tfile_name\tmd5sum\tfile_size\tdata_type\texperimental_strategy\tcases.case_id\n';
      res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${id}_manifest.tsv"`);
      return res.send(empty);
    }
    const body = req.body || {};
    const dataTypes = Array.isArray(body.data_types) ? body.data_types : ['Gene Expression Quantification'];
    const strategies = Array.isArray(body.experimental_strategy) ? body.experimental_strategy : null;
    const access = body.access === 'open' || body.access === 'controlled' ? body.access : null;

    const content = [
      { op: 'in', content: { field: 'cases.case_id', value: caseIds } },
      { op: 'in', content: { field: 'data_type', value: dataTypes } },
    ];
    if (strategies && strategies.length > 0) {
      content.push({ op: 'in', content: { field: 'experimental_strategy', value: strategies } });
    }
    if (access) {
      content.push({ op: '=', content: { field: 'access', value: [access] } });
    }

    const gdcBody = {
      filters: { op: 'and', content },
      format: 'TSV',
      fields: 'file_id,file_name,md5sum,file_size,data_type,experimental_strategy,cases.case_id',
      size: 10000,
      from: 0,
    };

    const tsv = await gdcRequestText('/files', { method: 'POST', body: gdcBody });
    ensureDataDir();
    const manifestPath = path.join(DATA_DIR, `${id}_manifest.tsv`);
    fs.writeFileSync(manifestPath, tsv, 'utf8');

    res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${id}_manifest.tsv"`);
    res.send(tsv);
  } catch (err) {
    console.error('POST /api/cohorts/:id/export/files-manifest', err);
    res.status(502).json({
      error: 'GDC request failed',
      message: err.message,
    });
  }
});

/** Build report content from cohort artifacts. Only includes sections when data exists. generatedAt = ISO string; artifactsIncluded = [{ path, mtime }]. */
function buildReport(id, snapshot, summary, survival, manifestLines, generatedAt, artifactsIncluded) {
  const ts = generatedAt || new Date().toISOString();
  const lines = [];

  lines.push(`# Cohort Report — ${id}`);
  lines.push('');
  lines.push(`Generated at: ${ts}`);
  lines.push('');
  lines.push('## 1. Cohort definition');
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| cohort_id | ${snapshot.id ?? id} |`);
  lines.push(`| profile | ${snapshot.profileName ?? snapshot.profileId ?? snapshot.profileKey ?? '—'} |`);
  lines.push(`| gdc_project_id | ${snapshot.gdc_project_id ?? '—'} |`);
  lines.push(`| n_cases | ${snapshot.n_cases ?? '—'} |`);
  lines.push(`| filters | ${JSON.stringify(snapshot.filters ?? {})} |`);
  lines.push('');

  if (artifactsIncluded && artifactsIncluded.length > 0) {
    lines.push('## 2. Artifacts included');
    lines.push('');
    lines.push('| Path | Last modified |');
    lines.push('|------|---------------|');
    for (const a of artifactsIncluded) {
      lines.push(`| \`${a.path}\` | ${a.mtime} |`);
    }
    lines.push('');
  }

  if (summary) {
    lines.push('## 3. Data quality (missingness)');
    lines.push('');
    if (summary.missingness) {
      lines.push(`| Variable | Missing |`);
      lines.push(`|----------|----------|`);
      lines.push(`| gender | ${summary.missingness.gender ?? '—'} |`);
      lines.push(`| stage | ${summary.missingness.stage ?? '—'} |`);
      lines.push('');
    }

    lines.push('## 4. Summary tables');
    lines.push('');
    if (summary.gender && Object.keys(summary.gender).length > 0) {
      lines.push('### Gender');
      lines.push('');
      lines.push('| Gender | Count |');
      lines.push('|--------|-------|');
      for (const [k, v] of Object.entries(summary.gender)) {
        lines.push(`| ${k} | ${v} |`);
      }
      lines.push('');
    }
    if (summary.stage && Object.keys(summary.stage).length > 0) {
      lines.push('### Stage');
      lines.push('');
      lines.push('| Stage | Count |');
      lines.push('|-------|-------|');
      const stageEntries = Object.entries(summary.stage).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
      for (const [k, v] of stageEntries) {
        lines.push(`| ${k} | ${v} |`);
      }
      lines.push('');
    }
  } else {
    lines.push('## 3. Summary');
    lines.push('');
    lines.push('Summary not generated yet.');
    lines.push('');
  }

  if (survival) {
    lines.push('## 5. Survival (Kaplan–Meier)');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| n_total | ${survival.n_total ?? '—'} |`);
    lines.push(`| n_events | ${survival.n_events ?? '—'} |`);
    lines.push(`| with_os | ${survival.n_with_os ?? survival.missingness?.with_os ?? '—'} |`);
    if (survival.missingness) {
      lines.push(`| missing_os | ${survival.missingness.missing_os ?? '—'} |`);
    }
    if (survival.p_value != null) {
      lines.push(`| log-rank p | ${survival.p_value < 0.001 ? '<0.001' : survival.p_value} |`);
    }
    lines.push('');
    lines.push(`Full survival data: \`data/${id}_survival.json\`.`);
    lines.push('');
  } else {
    lines.push('## 5. Survival');
    lines.push('');
    lines.push('Survival not generated yet.');
    lines.push('');
  }

  if (manifestLines !== null) {
    lines.push('## 6. Files manifest');
    lines.push('');
    lines.push(`Manifest available: \`data/${id}_manifest.tsv\` (${manifestLines} rows, including header).`);
    lines.push('');
  } else {
    lines.push('## 6. Files manifest');
    lines.push('');
    lines.push('Manifest not generated yet.');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('*This report is for **exploratory research use only**. Not for clinical or regulatory use.*');
  lines.push('');

  return lines.join('\n');
}

/** Load cohort artifacts from disk. Returns { snapshot, summary, survival, manifestLines, artifactsIncluded }. */
function loadCohortArtifacts(id) {
  const snapshotPath = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(snapshotPath)) return null;
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const artifactsIncluded = [];
  const addArtifact = (filePath) => {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      artifactsIncluded.push({ path: path.basename(filePath), mtime: stat.mtime.toISOString() });
    }
  };
  addArtifact(snapshotPath);
  let summary = null;
  let survival = null;
  let manifestLines = null;
  const summaryPath = path.join(DATA_DIR, `${id}_summary.json`);
  const survivalPath = path.join(DATA_DIR, `${id}_survival.json`);
  const manifestPath = path.join(DATA_DIR, `${id}_manifest.tsv`);
  if (fs.existsSync(summaryPath)) {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    addArtifact(summaryPath);
  }
  if (fs.existsSync(survivalPath)) {
    survival = JSON.parse(fs.readFileSync(survivalPath, 'utf8'));
    addArtifact(survivalPath);
  }
  if (fs.existsSync(manifestPath)) {
    const content = fs.readFileSync(manifestPath, 'utf8');
    manifestLines = content.split('\n').filter((l) => l.trim()).length;
    addArtifact(manifestPath);
  }
  return { snapshot, summary, survival, manifestLines, artifactsIncluded };
}

function markdownToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inTable = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('# ')) {
      if (inTable) { out.push('</table>'); inTable = false; }
      out.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    } else if (line.startsWith('## ')) {
      if (inTable) { out.push('</table>'); inTable = false; }
      out.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    } else if (line.startsWith('### ')) {
      if (inTable) { out.push('</table>'); inTable = false; }
      out.push(`<h3>${escapeHtml(line.slice(4))}</h3>`);
    } else if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1).map((c) => c.trim());
      if (/^\|\s*[-:]+\s*\|/.test(line)) {
        if (inTable) out.push('</thead><tbody>');
        continue;
      }
      if (!inTable) { out.push('<table><thead><tr>'); inTable = true; }
      const inTbody = out[out.length - 1] === '</thead><tbody>';
      out.push('<tr>' + cells.map((c) => `<${inTbody ? 'td' : 'th'}>${escapeHtml(c)}</${inTbody ? 'td' : 'th'}>`).join('') + '</tr>');
    } else if (line.trim() === '') {
      if (inTable) { out.push('</table>'); inTable = false; }
      out.push('<br/>');
    } else {
      if (inTable) { out.push('</table>'); inTable = false; }
      out.push(`<p>${escapeHtml(line).replace(/\`([^`]+)\`/g, '<code>$1</code>')}</p>`);
    }
  }
  if (inTable) {
    if (out.includes('</thead><tbody>')) out.push('</tbody>');
    out.push('</table>');
  }
  return out.join('\n');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// POST /api/cohorts/:id/report — rebuild report from latest artifacts on disk; only called when user clicks "Generate Report"
app.post('/api/cohorts/:id/report', (req, res) => {
  try {
    const { id } = req.params;
    const loaded = loadCohortArtifacts(id);
    if (!loaded) {
      return res.status(404).json({ error: `Cohort not found: ${id}` });
    }
    const { snapshot, summary, survival, manifestLines, artifactsIncluded } = loaded;
    const generatedAt = new Date().toISOString();
    const md = buildReport(id, snapshot, summary, survival, manifestLines, generatedAt, artifactsIncluded);
    ensureDataDir();
    const mdPath = path.join(DATA_DIR, `${id}_report.md`);
    fs.writeFileSync(mdPath, md, 'utf8');
    const body = markdownToHtml(md);
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>Cohort Report — ${escapeHtml(id)}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; color: #1e293b; }
    table { border-collapse: collapse; width: 100%; margin: 0.5rem 0; }
    th, td { border: 1px solid #cbd5e1; padding: 0.4rem 0.6rem; text-align: left; }
    th { background: #f1f5f9; }
    code { background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 3px; }
    @media print { body { margin: 0; } }
  </style>
</head>
<body>
${body}
</body>
</html>`;
    const htmlPath = path.join(DATA_DIR, `${id}_report.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');
    res.json({ ok: true, generatedAt, artifactsIncluded });
  } catch (err) {
    console.error('POST /api/cohorts/:id/report', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cohorts/:id/report.md — serve existing report file only (do not generate)
app.get('/api/cohorts/:id/report.md', (req, res) => {
  try {
    const { id } = req.params;
    const mdPath = path.join(DATA_DIR, `${id}_report.md`);
    if (!fs.existsSync(mdPath)) {
      return res.status(404).json({ error: 'Report not generated yet. Click "Generate Report" first.' });
    }
    const md = fs.readFileSync(mdPath, 'utf8');
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${id}_report.md"`);
    res.send(md);
  } catch (err) {
    console.error('GET /api/cohorts/:id/report.md', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cohorts/:id/report.html — serve existing report file only (do not generate)
app.get('/api/cohorts/:id/report.html', (req, res) => {
  try {
    const { id } = req.params;
    const htmlPath = path.join(DATA_DIR, `${id}_report.html`);
    if (!fs.existsSync(htmlPath)) {
      return res.status(404).send('Report not generated yet. Click "Generate Report" first.');
    }
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('GET /api/cohorts/:id/report.html', err);
    res.status(500).send('Report generation failed');
  }
});

// POST /api/cohorts/:id/survival — Kaplan-Meier OS, optional stratification
app.post('/api/cohorts/:id/survival', async (req, res) => {
  try {
    const { id } = req.params;
    const snapshotPath = path.join(DATA_DIR, `${id}.json`);
    if (!fs.existsSync(snapshotPath)) {
      return res.status(404).json({ error: `Cohort not found: ${id}` });
    }
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
    const caseIds = snapshot.case_ids || [];
    if (caseIds.length === 0) {
      return res.status(400).json({
        error: 'Cohort has no cases',
        missingness: { total: 0, with_os: 0, missing_os: 0 },
      });
    }

    const body = {
      filters: { op: 'in', content: { field: 'case_id', value: caseIds } },
      format: 'JSON',
      expand: 'demographic,diagnoses',
      fields: 'case_id,demographic.gender,demographic.vital_status,demographic.days_to_death,demographic.days_to_last_follow_up,diagnoses.days_to_death,diagnoses.days_to_last_follow_up,diagnoses.vital_status,diagnoses.ajcc_pathologic_stage,diagnoses.tumor_stage,diagnoses.ajcc_clinical_stage',
      size: Math.min(caseIds.length, 10000),
      from: 0,
    };

    const data = await gdcRequest('/cases', { method: 'POST', body });
    const hits = data?.data?.hits ?? [];

    const rows = [];
    let n_with_vital_status = 0;
    let n_with_days_to_death = 0;
    let n_with_last_follow_up = 0;
    const stratifyBy = req.body?.stratify_by === 'gender' || req.body?.stratify_by === 'stage' ? req.body.stratify_by : null;

    for (const h of hits) {
      const os = getOSFromHit(h);
      if (os.vital_status !== '') n_with_vital_status++;
      if (os.hasDaysToDeath) n_with_days_to_death++;
      if (os.hasDaysToFollowUp) n_with_last_follow_up++;
      if (os.time == null) continue;
      const row = { time: os.time, event: os.event };
      if (stratifyBy === 'gender') {
        row.stratum = (h.demographic?.gender ?? '').trim() || '(missing)';
      } else if (stratifyBy === 'stage') {
        row.stratum = getCanonicalStage(h).stage;
      }
      rows.push(row);
    }

    const nTotal = hits.length;
    const nWithOs = rows.length;
    const missingOs = nTotal - nWithOs;
    const missingness = { total: nTotal, with_os: nWithOs, missing_os: missingOs };
    const nEvents = rows.filter((r) => r.event === 1).length;
    const n_dead = nEvents;
    const n_alive = nWithOs - n_dead;
    const max_time = rows.length > 0 ? Math.max(...rows.map((r) => r.time)) : 0;

    if (nWithOs < Math.ceil(nTotal * 0.1)) {
      return res.status(400).json({
        error: 'Insufficient survival data: fewer than 10% of cases have OS time (days_to_death or days_to_last_follow_up). Cannot compute KM.',
        missingness,
        n_with_time: nWithOs,
        n_with_vital_status,
        n_dead,
        n_alive,
        n_with_days_to_death,
        n_with_last_follow_up,
        n_events: nEvents,
        max_time,
      });
    }

    const kmPoints = kaplanMeier(rows);

    const out = {
      cohort_id: id,
      n_total: nTotal,
      n_events: nEvents,
      n_with_os: nWithOs,
      n_with_time: nWithOs,
      n_with_vital_status,
      n_dead,
      n_alive,
      n_with_days_to_death,
      n_with_last_follow_up,
      max_time,
      missingness,
      km_points: kmPoints,
    };

    if (stratifyBy) {
      const strata = [...new Set(rows.map((r) => r.stratum))];
      const groups = strata.map((name) => {
        const sub = rows.filter((r) => r.stratum === name);
        return { name, n: sub.length, km_points: kaplanMeier(sub) };
      });
      out.groups = groups;
      if (strata.length === 2) {
        const groupMap = new Map(strata.map((s, i) => [s, i]));
        const rowsWithGroup = rows.map((r) => ({ ...r, group: groupMap.get(r.stratum) }));
        const pValue = logRankPValue(rowsWithGroup);
        if (pValue != null) out.p_value = pValue;
      }
    }

    ensureDataDir();
    const outPath = path.join(DATA_DIR, `${id}_survival.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
    res.json(out);
  } catch (err) {
    console.error('POST /api/cohorts/:id/survival', err);
    res.status(502).json({
      error: err.message?.includes('GDC') ? 'GDC request failed' : 'Survival computation failed',
      message: err.message,
    });
  }
});

const server = app.listen(API_PORT, 'localhost', () => {
  console.log('UI: http://localhost:3000');
  console.log(`API: http://localhost:${API_PORT}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`API port ${API_PORT} already in use. Set API_PORT=xxxx or stop the process.`);
    process.exit(1);
  }
  throw err;
});
