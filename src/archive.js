// Client des routes /bordereaux/* du Worker studyforge-proxy.
// Auth : token partagé équipe Cameleons (X-Auth-Token), stocké en localStorage.

const API_BASE = 'https://studyforge-proxy.benoit-comas.workers.dev';
const TOKEN_KEY = 'cameleons_auth_token';
const EMAIL_KEY = 'cameleons_user_email';

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setAuthToken(t) { localStorage.setItem(TOKEN_KEY, t); }
export function getUserEmail() { return localStorage.getItem(EMAIL_KEY) || ''; }
export function setUserEmail(e) { localStorage.setItem(EMAIL_KEY, e); }

function headers() {
  return {
    'Content-Type': 'application/json',
    'X-Auth-Token': getAuthToken(),
    'X-User-Email': getUserEmail(),
  };
}

async function call(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* raw */ }
  if (!res.ok) {
    const msg = data?.error || text || res.statusText;
    throw new Error(`${res.status}: ${msg}`);
  }
  return data;
}

// Lit un File en base64 (sans préfixe data:...;base64,)
async function fileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(',')[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// SHA-256 du contenu d'un File (hex) — via Web Crypto natif, pas de lib
export async function sha256File(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// POST /bordereaux/batch/check-hashes → { known: [...], unknown: [...] }
export async function checkHashes(hashes) {
  if (!hashes || hashes.length === 0) return { known: [], unknown: [] };
  return call('/bordereaux/batch/check-hashes', {
    method: 'POST',
    body: JSON.stringify({ hashes }),
  });
}

export async function saveBordereau({ bordereau, dayHoursFn, csvPld, source = 'manual', pdfFile = null, fileHash = null }) {
  const jours = (bordereau.jours || []).map((j) => {
    const h = dayHoursFn(j);
    return { ...j, totalHt: h.jour, totalHn: h.nuit };
  });
  const totalHt = jours.reduce((s, j) => s + (j.totalHt || 0), 0);
  const totalHn = jours.reduce((s, j) => s + (j.totalHn || 0), 0);

  let pdfBase64 = null, pdfMediaType = null;
  if (pdfFile) {
    pdfBase64 = await fileToB64(pdfFile);
    pdfMediaType = pdfFile.type || 'application/octet-stream';
  }

  return call('/bordereaux/save', {
    method: 'POST',
    body: JSON.stringify({
      nom: bordereau.nom,
      prenom: bordereau.prenom,
      matricule: bordereau.matricule,
      client: bordereau.client,
      contratDefaut: bordereau.contratDefaut,
      semaineDu: bordereau.semaineDu,
      semaineAu: bordereau.semaineAu,
      totalHt: Math.round(totalHt * 100) / 100,
      totalHn: Math.round(totalHn * 100) / 100,
      jours,
      csvPld,
      source,
      pdfBase64,
      pdfMediaType,
      fileHash,
    }),
  });
}

export async function listBordereaux(filters = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) q.set(k, v);
  return call(`/bordereaux/list?${q.toString()}`);
}

export async function getBordereau(id) {
  return call(`/bordereaux/get/${id}`);
}

// PATCH — met à jour un bordereau existant (le PDF R2 original reste intact).
export async function updateBordereau(id, { bordereau, dayHoursFn, csvPld }) {
  const jours = (bordereau.jours || []).map((j) => {
    const h = dayHoursFn(j);
    return { ...j, totalHt: h.jour, totalHn: h.nuit };
  });
  const totalHt = jours.reduce((s, j) => s + (j.totalHt || 0), 0);
  const totalHn = jours.reduce((s, j) => s + (j.totalHn || 0), 0);
  return call(`/bordereaux/update/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      nom: bordereau.nom,
      prenom: bordereau.prenom,
      matricule: bordereau.matricule,
      client: bordereau.client,
      contratDefaut: bordereau.contratDefaut,
      semaineDu: bordereau.semaineDu,
      semaineAu: bordereau.semaineAu,
      totalHt: Math.round(totalHt * 100) / 100,
      totalHn: Math.round(totalHn * 100) / 100,
      jours,
      csvPld,
    }),
  });
}

export async function deleteBordereau(id) {
  return call(`/bordereaux/delete/${id}`, { method: 'DELETE' });
}

// Récupère les détails complets (jours_json inclus) pour une liste d'IDs —
// usage principal : export CSV groupé.
export async function batchFetchBordereaux(ids) {
  if (!ids || ids.length === 0) return { bordereaux: [] };
  return call('/bordereaux/batch-fetch', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
}

// Archive le CSV en R2, crée un export_batches, marque exported=true.
// Renvoie { batchId, r2Key, count, periodStart, periodEnd }.
export async function batchExport({ ids, csv, notes }) {
  return call('/bordereaux/batch-export', {
    method: 'POST',
    body: JSON.stringify({ ids, csv, notes }),
  });
}

export async function listExportBatches() {
  return call('/bordereaux/export-batches');
}
export function exportBatchDownloadUrl(id) {
  return `${API_BASE}/bordereaux/export-batches/${id}/download`;
}

// Récupère un PDF depuis R2 (via proxy worker) en blob URL pour <img>/<iframe>.
// L'appelant DOIT faire URL.revokeObjectURL() quand il ferme la preview.
export async function fetchPdfBlobUrl(r2Key) {
  const res = await fetch(`${API_BASE}/bordereaux/pdf/${r2Key}`, { headers: headers() });
  if (!res.ok) throw new Error(`PDF ${res.status}: ${res.statusText}`);
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), mediaType: blob.type || 'application/octet-stream' };
}

export async function rgpdExport(nom, prenom) {
  const q = new URLSearchParams({ nom, prenom });
  return call(`/bordereaux/rgpd/export?${q.toString()}`);
}

export async function rgpdForget(nom, prenom) {
  const q = new URLSearchParams({ nom, prenom });
  return call(`/bordereaux/rgpd/forget?${q.toString()}`, { method: 'DELETE' });
}

// --- Intérimaires (base Notion) ---
export async function importIntermediaires({ rows, csvRaw, filename, errors }) {
  return call('/bordereaux/interimaires/import', {
    method: 'POST',
    body: JSON.stringify({ rows, csvRaw, filename, errors }),
  });
}

export async function listSnapshots() {
  return call('/bordereaux/interimaires/snapshots');
}

export function snapshotDownloadUrl(id) {
  return `https://studyforge-proxy.benoit-comas.workers.dev/bordereaux/interimaires/snapshot/${id}/download`;
}

export async function matchIntermediaire({ q, nom, prenom, date, limit = 10 }) {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (nom) params.set('nom', nom);
  if (prenom) params.set('prenom', prenom);
  if (date) params.set('date', date);
  params.set('limit', String(limit));
  return call(`/bordereaux/interimaires/match?${params.toString()}`);
}

export async function listIntermediaires(limit = 100) {
  return call(`/bordereaux/interimaires/list?limit=${limit}`);
}
