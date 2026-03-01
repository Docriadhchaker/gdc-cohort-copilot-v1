import React, { useState, useEffect, useRef } from 'react';

const API = '/api';

function copyToClipboard(text) {
  return navigator.clipboard?.writeText(text).catch(() => {});
}

function KMCurve({ points, width = 400, height = 220, color = '#818cf8', title }) {
  if (!points || points.length === 0) return null;
  const maxT = Math.max(...points.map((p) => p.t), 1);
  const padding = { top: 20, right: 20, bottom: 32, left: 44 };
  const w = width - padding.left - padding.right;
  const h = height - padding.top - padding.bottom;
  const x = (t) => padding.left + (t / maxT) * w;
  const y = (s) => padding.top + (1 - s) * h;
  const stepPath = [];
  stepPath.push(`M ${x(0)} ${y(1)}`);
  for (let i = 0; i < points.length; i++) {
    const { t, s } = points[i];
    if (i > 0) stepPath.push(`L ${x(t)} ${y(points[i - 1].s)}`);
    stepPath.push(`L ${x(t)} ${y(s)}`);
  }
  return (
    <svg width={width} height={height} className="overflow-visible">
      {title && (
        <text x={padding.left} y={14} className="fill-slate-400 text-xs" style={{ fontFamily: 'system-ui' }}>{title}</text>
      )}
      <line x1={padding.left} y1={padding.top} x2={padding.left} y2={padding.top + h} className="stroke-slate-600" strokeWidth="1" />
      <line x1={padding.left} y1={padding.top + h} x2={padding.left + w} y2={padding.top + h} className="stroke-slate-600" strokeWidth="1" />
      <path d={stepPath.join(' ')} fill="none" stroke={color} strokeWidth="2" />
      <text x={padding.left + w / 2} y={height - 6} className="fill-slate-500 text-xs" textAnchor="middle" style={{ fontFamily: 'system-ui' }}>Time (days)</text>
      <text x={padding.left - 8} y={padding.top + h / 2} className="fill-slate-500 text-xs" textAnchor="middle" transform={`rotate(-90 ${padding.left - 8} ${padding.top + h / 2})`} style={{ fontFamily: 'system-ui' }}>Survival</text>
    </svg>
  );
}

export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [profileId, setProfileId] = useState('');
  const [profileSearch, setProfileSearch] = useState('');
  const [stage, setStage] = useState('');
  const [stageGroup, setStageGroup] = useState('');
  const [stageOptions, setStageOptions] = useState([]);
  const [stageOptionsLoading, setStageOptionsLoading] = useState(false);
  const [gender, setGender] = useState('');
  const [cohort, setCohort] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingAction, setLoadingAction] = useState(null);
  const [error, setError] = useState(null);
  const [copyFeedback, setCopyFeedback] = useState(null);
  const copyFeedbackTimer = useRef(null);
  const [showManifestModal, setShowManifestModal] = useState(false);
  const [manifestPresets, setManifestPresets] = useState({ rnaseq: true, somatic: false, wxs: false });
  const [exportingManifest, setExportingManifest] = useState(false);
  const [survival, setSurvival] = useState(null);
  const [survivalStratify, setSurvivalStratify] = useState('');
  const [reportReady, setReportReady] = useState(false);
  const [reportGeneratedAt, setReportGeneratedAt] = useState(null);
  const [reportGenerating, setReportGenerating] = useState(false);

  useEffect(() => {
    fetch(`${API}/profiles`)
      .then((r) => r.json())
      .then(setProfiles)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (profiles.length && !profileId) setProfileId(profiles[0].id);
  }, [profiles, profileId]);

  useEffect(() => {
    const key = profileId || profiles[0]?.id;
    if (!key) return;
    setStageOptionsLoading(true);
    setStageOptions([]);
    setStage('');
    setStageGroup('');
    fetch(`${API}/stage-options?profileKey=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .then((data) => Array.isArray(data) ? setStageOptions(data) : setStageOptions([]))
      .catch(() => setStageOptions([]))
      .finally(() => setStageOptionsLoading(false));
  }, [profileId]);

  useEffect(() => {
    setReportReady(false);
    setReportGeneratedAt(null);
  }, [cohort?.id]);

  const createCohort = async () => {
    setError(null);
    setCohort(null);
    setSummary(null);
    setSurvival(null);
    setReportReady(false);
    setLoading(true);
    setLoadingAction('Creating cohort…');
    try {
      const res = await fetch(`${API}/cohorts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profileKey: profileId || profiles[0]?.id,
          filters: {
            ...(stage && stage !== 'any' && { stage: stage.trim() }),
            ...(stageGroup && stageGroup !== 'any' && !stage && { stageGroup: stageGroup.trim() }),
            ...(gender && gender !== 'any' && { gender: gender.trim() }),
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.message || data.error || res.statusText;
        throw new Error(typeof msg === 'string' ? msg : 'GDC request failed');
      }
      setCohort(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setLoadingAction(null);
    }
  };

  const runSummary = async () => {
    if (!cohort?.id) return;
    setError(null);
    setSummary(null);
    setLoading(true);
    setLoadingAction('Running summary…');
    try {
      const res = await fetch(`${API}/cohorts/${cohort.id}/summary`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.message || data.error || res.statusText;
        throw new Error(typeof msg === 'string' ? msg : 'GDC request failed');
      }
      setSummary(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setLoadingAction(null);
    }
  };

  const runSurvival = async () => {
    if (!cohort?.id) return;
    setError(null);
    setSurvival(null);
    setLoading(true);
    setLoadingAction('Running survival…');
    try {
      const res = await fetch(`${API}/cohorts/${cohort.id}/survival`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stratify_by: survivalStratify === 'gender' || survivalStratify === 'stage' ? survivalStratify : null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data.message || data.error || res.statusText;
        throw new Error(typeof msg === 'string' ? msg : 'Survival computation failed');
      }
      setSurvival(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setLoadingAction(null);
    }
  };

  const first10 = cohort?.case_ids?.slice(0, 10) ?? [];
  const allCaseIds = cohort?.case_ids ?? [];

  const showCopyFeedback = (msg) => {
    if (copyFeedbackTimer.current) clearTimeout(copyFeedbackTimer.current);
    setCopyFeedback(msg);
    copyFeedbackTimer.current = setTimeout(() => {
      setCopyFeedback(null);
      copyFeedbackTimer.current = null;
    }, 2000);
  };

  const handleCopyId = (id) => {
    copyToClipboard(id).then(() => showCopyFeedback('Copied'));
  };

  const handleCopyAllIds = () => {
    copyToClipboard(allCaseIds.join('\n')).then(() => showCopyFeedback('All copied'));
  };

  const handleCopyCohortId = () => {
    copyToClipboard(cohort?.id ?? '').then(() => showCopyFeedback('Cohort ID copied'));
  };

  const downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportCaseIdsCsv = async () => {
    if (!cohort?.id) return;
    setError(null);
    try {
      const res = await fetch(`${API}/cohorts/${cohort.id}/export/case_ids.csv`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || res.statusText);
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition');
      const match = disp && disp.match(/filename="?([^";]+)"?/);
      downloadBlob(blob, match ? match[1] : `${cohort.id}_case_ids.csv`);
    } catch (e) {
      setError(e.message);
    }
  };

  const handleGenerateReport = async () => {
    if (!cohort?.id) return;
    setError(null);
    setReportGenerating(true);
    try {
      const res = await fetch(`${API}/cohorts/${cohort.id}/report`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || res.statusText);
      setReportReady(true);
      setReportGeneratedAt(data.generatedAt || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setReportGenerating(false);
    }
  };

  const handleExportFilesManifest = async () => {
    if (!cohort?.id) return;
    const dataTypes = [];
    if (manifestPresets.rnaseq) dataTypes.push('Gene Expression Quantification');
    if (manifestPresets.somatic) dataTypes.push('Masked Somatic Mutation');
    if (manifestPresets.wxs) dataTypes.push('Aligned Reads');
    const strategies = [];
    if (manifestPresets.rnaseq) strategies.push('RNA-Seq');
    if (manifestPresets.wxs) strategies.push('WXS');
    if (dataTypes.length === 0) dataTypes.push('Gene Expression Quantification');

    setExportingManifest(true);
    setError(null);
    try {
      const res = await fetch(`${API}/cohorts/${cohort.id}/export/files-manifest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          data_types: dataTypes,
          ...(strategies.length > 0 && { experimental_strategy: strategies }),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || res.statusText);
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition');
      const match = disp && disp.match(/filename="?([^";]+)"?/);
      downloadBlob(blob, match ? match[1] : `${cohort.id}_manifest.tsv`);
      setShowManifestModal(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setExportingManifest(false);
    }
  };

  const stageEntries = summary?.stage && typeof summary.stage === 'object'
    ? Object.entries(summary.stage).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    : [];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-700 bg-slate-800/50 px-4 py-4 sm:px-6">
        <h1 className="text-xl font-semibold text-white">GDC Cohort Copilot</h1>
        <p className="text-sm text-slate-400 mt-0.5">Exploratory research use only</p>
      </header>

      {/* Error banner */}
      {error && (
        <div className="bg-red-900/30 border-b border-red-700 text-red-200 px-4 py-3 text-sm" role="alert">
          {error}
        </div>
      )}

      {/* Copy feedback toast */}
      {copyFeedback && (
        <div className="fixed top-4 right-4 bg-slate-700 text-white text-sm px-3 py-2 rounded shadow-lg z-10">
          {copyFeedback}
        </div>
      )}

      <main className="flex-1 p-4 sm:p-6 max-w-6xl mx-auto w-full">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Controls */}
          <div className="rounded-xl bg-slate-800/80 border border-slate-700 shadow-lg p-5 space-y-4">
            <h2 className="text-base font-medium text-slate-200">Controls</h2>

            <div>
              <label className="block text-sm text-slate-400 mb-1">Profile</label>
              <input
                type="text"
                placeholder="Filter profiles…"
                value={profileSearch}
                onChange={(e) => setProfileSearch(e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 text-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent mb-2"
                disabled={loading}
              />
              <select
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 text-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                disabled={loading}
              >
                {(() => {
                  const q = (profileSearch || '').trim().toLowerCase();
                  const filtered = q
                    ? profiles.filter(
                        (p) =>
                          (p.id || '').toLowerCase().includes(q) ||
                          (p.name || '').toLowerCase().includes(q) ||
                          (p.description || '').toLowerCase().includes(q)
                      )
                    : profiles;
                  const selected = profiles.find((p) => p.id === profileId);
                  const options =
                    selected && !filtered.some((p) => p.id === profileId) ? [selected, ...filtered] : filtered;
                  return options.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} – {p.description}</option>
                  ));
                })()}
              </select>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-1">Gender</label>
              <select
                value={gender || 'any'}
                onChange={(e) => setGender(e.target.value === 'any' ? '' : e.target.value)}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 text-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              >
                <option value="any">Any</option>
                <option value="female">female</option>
                <option value="male">male</option>
              </select>
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-1">Stage (exact)</label>
              <select
                value={stage || 'any'}
                onChange={(e) => {
                  const v = e.target.value === 'any' ? '' : e.target.value;
                  setStage(v);
                  if (v) setStageGroup('');
                }}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 text-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                disabled={loading || stageOptionsLoading}
              >
                <option value="any">Any</option>
                {stageOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.value} ({o.count})
                  </option>
                ))}
              </select>
              {stageOptionsLoading && <p className="text-xs text-slate-500 mt-1">Loading stages…</p>}
            </div>

            <div>
              <label className="block text-sm text-slate-400 mb-1">Stage group (I/II/III/IV)</label>
              <select
                value={stageGroup || 'any'}
                onChange={(e) => {
                  const v = e.target.value === 'any' ? '' : e.target.value;
                  setStageGroup(v);
                  if (v) setStage('');
                }}
                className="w-full rounded-lg border border-slate-600 bg-slate-700 text-slate-200 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500"
                disabled={loading}
              >
                <option value="any">Any</option>
                <option value="I">I (Stage I, IA, IB, IC)</option>
                <option value="II">II (Stage II, IIA, IIB, IIC)</option>
                <option value="III">III (Stage III, IIIA, IIIB, IIIC)</option>
                <option value="IV">IV (Stage IV)</option>
              </select>
            </div>

            <div className="pt-2 space-y-2">
              <button
                onClick={createCohort}
                disabled={loading}
                className="w-full rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 px-4 text-sm transition"
              >
                {loading && loadingAction === 'Creating cohort…' ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Creating cohort…
                  </span>
                ) : (
                  'Create Cohort'
                )}
              </button>
              <p className="text-xs text-slate-500">Query GDC with the selected profile and filters; returns cohort id and case list.</p>

              <button
                onClick={runSummary}
                disabled={loading || !cohort?.id}
                className="w-full rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 px-4 text-sm transition"
              >
                {loading && loadingAction === 'Running summary…' ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Running summary…
                  </span>
                ) : (
                  'Run Cohort Summary'
                )}
              </button>
              <p className="text-xs text-slate-500">Compute gender/stage distribution and missingness for the current cohort.</p>

              <div className="flex items-center gap-2">
                <select
                  value={survivalStratify || 'none'}
                  onChange={(e) => setSurvivalStratify(e.target.value === 'none' ? '' : e.target.value)}
                  className="rounded-lg border border-slate-600 bg-slate-700 text-slate-200 px-2 py-1.5 text-xs focus:ring-2 focus:ring-blue-500"
                  disabled={loading || !cohort?.id}
                >
                  <option value="none">Survival: overall</option>
                  <option value="gender">Stratify by gender</option>
                  <option value="stage">Stratify by stage</option>
                </select>
                <button
                  onClick={runSurvival}
                  disabled={loading || !cohort?.id}
                  className="flex-1 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium py-2.5 px-4 text-sm transition"
                >
                  {loading && loadingAction === 'Running survival…' ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Running survival…
                    </span>
                  ) : (
                    'Run Survival Pack'
                  )}
                </button>
              </div>
              <p className="text-xs text-slate-500">Kaplan-Meier overall survival; optional stratification (log-rank p when 2 groups).</p>
            </div>

            <hr className="border-slate-600 my-4" />

            <div className="space-y-2">
              <span className="text-sm text-slate-400 font-medium block">Actions</span>
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={handleExportCaseIdsCsv} disabled={!cohort?.id} className="rounded px-3 py-1.5 text-xs bg-slate-600 hover:bg-slate-500 text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed">
                  Export case_ids CSV
                </button>
                <button type="button" onClick={() => setShowManifestModal(true)} disabled={!cohort?.id} className="rounded px-3 py-1.5 text-xs bg-slate-600 hover:bg-slate-500 text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed">
                  Export files manifest
                </button>
                <button type="button" onClick={handleGenerateReport} disabled={reportGenerating || !cohort?.id} className="rounded px-3 py-1.5 text-xs bg-slate-600 hover:bg-slate-500 text-slate-200 disabled:opacity-50 disabled:cursor-not-allowed">
                  {reportGenerating ? 'Generating…' : 'Generate Report'}
                </button>
              </div>
              {reportReady && cohort?.id && (
                <div className="pt-2 space-y-1 text-xs">
                  {reportGeneratedAt && (
                    <p className="text-slate-500">Report last generated: {reportGeneratedAt}</p>
                  )}
                  <div className="flex flex-wrap gap-2 items-center">
                    <span className="text-slate-400">Report:</span>
                    <a href={`${API}/cohorts/${cohort.id}/report.html`} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">Preview (HTML)</a>
                    <a href={`${API}/cohorts/${cohort.id}/report.md`} download={`${cohort.id}_report.md`} className="text-blue-400 hover:text-blue-300">Download .md</a>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right: Results */}
          <div className="space-y-6">
            {/* Cohort card */}
            <div className="rounded-xl bg-slate-800/80 border border-slate-700 shadow-lg p-5">
              <h2 className="text-base font-medium text-slate-200 mb-3">Cohort</h2>
              {cohort ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-slate-400">ID:</span>
                    <code className="text-sm text-slate-300 bg-slate-700 px-2 py-1 rounded flex-1 min-w-0 truncate">{cohort.id}</code>
                    <button
                      type="button"
                      onClick={handleCopyCohortId}
                      className="rounded px-2 py-1 text-xs bg-slate-600 hover:bg-slate-500 text-slate-200"
                    >
                      Copy
                    </button>
                  </div>
                  <p className="text-sm"><span className="text-slate-400">n_cases:</span> <span className="font-medium text-white">{cohort.n_cases}</span></p>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-slate-400">First 10 case_ids</span>
                    {allCaseIds.length > 0 && (
                      <button type="button" onClick={handleCopyAllIds} className="text-xs text-blue-400 hover:text-blue-300">Copy all</button>
                    )}
                  </div>
                  <ul className="max-h-40 overflow-y-auto rounded border border-slate-600 bg-slate-700/50 p-2 space-y-1 text-xs font-mono text-slate-300">
                    {first10.map((id) => (
                      <li key={id} className="flex items-center gap-2 group">
                        <span className="truncate flex-1">{id}</span>
                        <button type="button" onClick={() => handleCopyId(id)} className="opacity-0 group-hover:opacity-100 rounded px-1.5 py-0.5 bg-slate-600 hover:bg-slate-500 text-slate-300 text-xs">Copy</button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-600 bg-slate-700/30 py-8 text-center text-sm text-slate-500">
                  No cohort yet. Create a cohort to see id, n_cases, and case_ids here.
                </div>
              )}
            </div>

            {/* Summary card */}
            <div className="rounded-xl bg-slate-800/80 border border-slate-700 shadow-lg p-5">
              <h2 className="text-base font-medium text-slate-200 mb-3">Summary</h2>
              {summary ? (
                <div className="space-y-4">
                  <p className="text-sm"><span className="text-slate-400">n_cases:</span> <span className="font-medium text-white">{summary.n_cases}</span></p>

                  {summary.gender && Object.keys(summary.gender).length > 0 && (
                    <div>
                      <span className="text-sm text-slate-400 block mb-1">Gender</span>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(summary.gender).map(([k, v]) => (
                          <span key={k} className="inline-flex items-center rounded-full bg-slate-600 px-3 py-1 text-sm text-slate-200">
                            {k}: {v}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {stageEntries.length > 0 && (
                    <div>
                      <span className="text-sm text-slate-400 block mb-1">Stage</span>
                      <div className="rounded border border-slate-600 overflow-hidden">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="bg-slate-700/50 text-slate-400 text-left">
                              <th className="px-3 py-2 font-medium">Stage</th>
                              <th className="px-3 py-2 font-medium text-right">Count</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stageEntries.map(([st, count]) => (
                              <tr key={st} className="border-t border-slate-600 text-slate-300">
                                <td className="px-3 py-2">{st}</td>
                                <td className="px-3 py-2 text-right">{count}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {summary.missingness && (
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded bg-amber-900/40 text-amber-200 px-2 py-1 text-xs">gender missing: {summary.missingness.gender ?? 0}</span>
                      <span className="rounded bg-amber-900/40 text-amber-200 px-2 py-1 text-xs">stage missing: {summary.missingness.stage ?? 0}</span>
                    </div>
                  )}
                  {summary.stage_source_counts && (
                    <p className="text-xs text-slate-500 mt-1">Stage source (debug): pathologic {summary.stage_source_counts.pathologic ?? 0}, clinical {summary.stage_source_counts.clinical ?? 0}, tumor {summary.stage_source_counts.tumor ?? 0}, missing {summary.stage_source_counts.missing ?? 0}</p>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-600 bg-slate-700/30 py-8 text-center text-sm text-slate-500">
                  No summary yet. Create a cohort, then run Cohort Summary to see gender/stage distribution and missingness.
                </div>
              )}
            </div>

            {/* Survival card */}
            <div className="rounded-xl bg-slate-800/80 border border-slate-700 shadow-lg p-5">
              <h2 className="text-base font-medium text-slate-200 mb-3">Survival (Kaplan-Meier)</h2>
              {survival ? (
                <div className="space-y-3">
                  <p className="text-sm">
                    <span className="text-slate-400">n_total:</span> {survival.n_total}
                    {' · '}
                    <span className="text-slate-400">n_events:</span> {survival.n_events}
                    {' · '}
                    <span className="text-slate-400">with OS:</span> {survival.n_with_os ?? survival.missingness?.with_os}
                  </p>
                  {survival.missingness && (
                    <p className="text-xs text-slate-500">
                      Missingness: total {survival.missingness.total}, missing_os {survival.missingness.missing_os}
                    </p>
                  )}
                  {survival.p_value != null && (
                    <p className="text-sm">
                      <span className="text-slate-400">Log-rank p-value:</span>{' '}
                      <span className="font-medium text-white">{survival.p_value < 0.001 ? '<0.001' : survival.p_value.toFixed(4)}</span>
                    </p>
                  )}
                  {survival.n_with_time === 0 ? (
                    <div className="rounded-lg border border-amber-600/50 bg-amber-900/20 py-4 px-3 text-sm text-amber-200">
                      No cases with survival time (days_to_death or days_to_last_follow_up). Check GDC data availability.
                    </div>
                  ) : (
                    <>
                      {survival.km_points?.length > 0 && (
                        <div className="bg-slate-900/50 rounded-lg p-2">
                          <KMCurve points={survival.km_points} color="#818cf8" title="Overall" />
                        </div>
                      )}
                      {survival.groups?.length > 0 && (
                        <div className="space-y-2">
                          {survival.groups.map((g, i) => (
                            <div key={g.name}>
                              <span className="text-xs text-slate-400">{g.name} (n={g.n})</span>
                              {g.km_points?.length > 0 && (
                                <div className="bg-slate-900/50 rounded-lg p-2">
                                  <KMCurve points={g.km_points} color={['#818cf8', '#f59e0b', '#10b981'][i % 3]} title={g.name} />
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {survival.n_with_time != null && (
                    <p className="text-xs text-slate-500">
                      n_with_time {survival.n_with_time}
                      {' · '}
                      n_with_vital_status {survival.n_with_vital_status ?? '—'}
                      {' · '}
                      n_dead {survival.n_dead ?? '—'}
                      {' · '}
                      n_alive {survival.n_alive ?? '—'}
                      {' · '}
                      n_with_days_to_death {survival.n_with_days_to_death ?? '—'}
                      {' · '}
                      n_with_last_follow_up {survival.n_with_last_follow_up ?? '—'}
                      {' · '}
                      n_events {survival.n_events}
                      {' · '}
                      max_time {survival.max_time ?? '—'}
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-600 bg-slate-700/30 py-8 text-center text-sm text-slate-500">
                  No survival run yet. Create a cohort, then run Survival Pack (optional: stratify by gender or stage).
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Files manifest export modal */}
      {showManifestModal && cohort?.id && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/50" onClick={() => !exportingManifest && setShowManifestModal(false)}>
          <div className="rounded-xl bg-slate-800 border border-slate-600 shadow-xl p-5 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-medium text-slate-200 mb-3">Export files manifest</h3>
            <p className="text-sm text-slate-400 mb-3">Select data type presets (GDC will be queried for files in this cohort):</p>
            <div className="space-y-2 mb-4">
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={manifestPresets.rnaseq} onChange={(e) => setManifestPresets((p) => ({ ...p, rnaseq: e.target.checked }))} className="rounded border-slate-500" />
                RNA-seq (Gene Expression Quantification)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={manifestPresets.somatic} onChange={(e) => setManifestPresets((p) => ({ ...p, somatic: e.target.checked }))} className="rounded border-slate-500" />
                Somatic mutations (Masked Somatic Mutation)
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
                <input type="checkbox" checked={manifestPresets.wxs} onChange={(e) => setManifestPresets((p) => ({ ...p, wxs: e.target.checked }))} className="rounded border-slate-500" />
                WXS BAM (Aligned Reads, WXS)
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setShowManifestModal(false)} disabled={exportingManifest} className="rounded px-3 py-1.5 text-sm bg-slate-600 hover:bg-slate-500 text-slate-200 disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={handleExportFilesManifest} disabled={exportingManifest} className="rounded px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">
                {exportingManifest ? 'Generating…' : 'Generate & download'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
