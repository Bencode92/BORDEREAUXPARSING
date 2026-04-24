// Batch upload : traite un ZIP (ou une sélection multi-fichiers) de bordereaux
// en enchaînant pour chacun : hash → dédup → OCR → match intérimaire → archive.
// Retourne un rapport structuré (nouveaux / duplicates / non-bordereaux / erreurs).

import JSZip from 'https://esm.sh/jszip@3.10.1';
import { sha256File, checkHashes, saveBordereau, matchIntermediaire } from './archive.js';
import { ocrBordereau } from './ocr.js';
import { dayHours } from './time-split.js';

// --- Extensions et détection ---
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);
const HEIC_EXT  = new Set(['heic', 'heif']);
const PDF_EXT   = new Set(['pdf']);
const ZIP_EXT   = new Set(['zip']);

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function isBordereauFile(file) {
  const e = extOf(file.name);
  return IMAGE_EXT.has(e) || PDF_EXT.has(e);
}

function isHeicFile(file) {
  const e = extOf(file.name);
  if (HEIC_EXT.has(e)) return true;
  const t = (file.type || '').toLowerCase();
  return t.includes('heic') || t.includes('heif');
}

// --- Extraction ZIP → liste de File ---
export async function extractZip(zipFile) {
  const zip = await JSZip.loadAsync(zipFile);
  const files = [];
  const skipped = [];
  const entries = [];
  zip.forEach((path, entry) => { entries.push({ path, entry }); });
  for (const { path, entry } of entries) {
    if (entry.dir) continue;
    // Skip les dossiers __MACOSX/ et fichiers ._xxx macOS resource forks
    const base = path.split('/').pop() || '';
    if (path.startsWith('__MACOSX/') || base.startsWith('._')) continue;
    const blob = await entry.async('blob');
    const mime = blob.type || guessMime(path);
    const f = new File([blob], base, { type: mime, lastModified: entry.date?.getTime() || Date.now() });
    if (isBordereauFile(f) || isHeicFile(f)) {
      files.push(f);
    } else {
      skipped.push({ file: f, reason: 'unsupported_format', details: `Extension .${extOf(f.name)} non prise en charge` });
    }
  }
  return { files, skipped };
}

function guessMime(name) {
  const e = extOf(name);
  if (e === 'pdf') return 'application/pdf';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'png') return 'image/png';
  if (e === 'webp') return 'image/webp';
  if (e === 'heic' || e === 'heif') return 'image/heic';
  return 'application/octet-stream';
}

// --- Conversion HEIC → JPEG (lazy-load de la lib, elle fait ~400 KB) ---
let _heic2any = null;
async function loadHeic2any() {
  if (_heic2any) return _heic2any;
  const mod = await import('https://esm.sh/heic2any@0.0.4');
  _heic2any = mod.default || mod;
  return _heic2any;
}

export async function convertHeicFile(heicFile) {
  const heic2any = await loadHeic2any();
  const jpegBlob = await heic2any({ blob: heicFile, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(jpegBlob) ? jpegBlob[0] : jpegBlob;
  const newName = heicFile.name.replace(/\.(heic|heif)$/i, '.jpg');
  return new File([blob], newName, { type: 'image/jpeg', lastModified: heicFile.lastModified });
}

// --- Helpers métier partagés avec le mode single-PDF ---
function snapToMonday(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const dow = d.getUTCDay();
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function mondayOfFirstWeek(moisReference) {
  if (!moisReference) return null;
  const [y, m] = moisReference.split('-').map(Number);
  if (!y || !m) return null;
  return snapToMonday(`${y}-${String(m).padStart(2, '0')}-01`);
}

function weekOverlapsMonth(lundiIso, moisReference) {
  if (!lundiIso || !moisReference) return false;
  const d = new Date(lundiIso + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    if (d.toISOString().slice(0, 7) === moisReference) return true;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return false;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Reconstruit les dates de chaque jour à partir de semaineDu (lundi).
// On IGNORE volontairement j.date renvoyé par l'OCR (redondant et source d'erreurs).
function buildJoursFromSemaine(joursOcr, semaineDu) {
  const JOURS_ORDER = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'];
  const byName = new Map();
  for (const j of joursOcr || []) {
    if (j.jour) byName.set(j.jour.toLowerCase(), j);
  }
  return JOURS_ORDER.map((nom, i) => {
    const j = byName.get(nom) || {};
    return {
      date: addDays(semaineDu, i),
      matin: { debut: j.matinDebut || '', fin: j.matinFin || '' },
      apresMidi: { debut: j.amDebut || '', fin: j.amFin || '' },
      contrat: '',
      ferie: !!j.ferie,
    };
  });
}

function findContratForDate(contrats, iso) {
  if (!contrats || !iso) return null;
  for (const c of contrats) {
    const debut = c.date_debut || c.debut;
    const fin   = c.date_fin   || c.fin;
    if ((!debut || debut <= iso) && (!fin || fin >= iso)) return c;
  }
  return null;
}

function formatContratValue(c) {
  if (!c) return '';
  const num = c.numero || c.numero_contrat;
  return c.avenant > 0 ? `${num},${c.avenant}` : String(num);
}

// --- Traite UN fichier : hash → OCR → match → archive (sans UI) ---
export async function processSingleFile(file, { moisReference, onStep } = {}) {
  const result = {
    filename: file.name,
    status: 'pending',
    hash: null,
    bordereauId: null,
    person: null,
    reason: null,
    details: null,
  };
  try {
    // 1. Hash
    onStep?.('hashing');
    result.hash = await sha256File(file);

    // 2. OCR
    onStep?.('ocr');
    const data = await ocrBordereau(file, { moisReference });
    if (!data || (!data.nom && !data.prenom) || !(data.jours || []).some(j => j.matinDebut || j.matinFin || j.amDebut || j.amFin)) {
      result.status = 'not_a_bordereau';
      result.reason = 'OCR n\'a pas trouvé de bordereau exploitable (ni nom+prénom ni heures)';
      return result;
    }

    // 3. Snap semaine au lundi + fallback mois de référence
    let semaine = snapToMonday(data.semaineDu);
    if (moisReference && (!semaine || !weekOverlapsMonth(semaine, moisReference))) {
      semaine = mondayOfFirstWeek(moisReference);
    }
    if (!semaine) {
      result.status = 'error';
      result.reason = 'Semaine impossible à déterminer (ni OCR ni mois de référence)';
      return result;
    }

    // 4. Match intérimaire — validation stricte : on n'archive QUE si match fiable
    onStep?.('matching');
    const q = `${data.prenom || ''} ${data.nom || ''}`.trim();
    const { matches } = await matchIntermediaire({
      q, nom: data.nom, prenom: data.prenom, date: semaine, limit: 5,
    });
    const best = (matches || [])[0];
    const SCORE_AUTO = 0.80;
    if (!best || best.score < SCORE_AUTO) {
      result.status = 'no_match';
      result.reason = `Aucune correspondance fiable en base (meilleur: ${best ? best.prenom + ' ' + best.nom + ' ' + Math.round(best.score*100) + '%' : 'aucun'})`;
      return result;
    }
    result.person = { id: best.id, nom: best.nom, prenom: best.prenom };

    // 5. Construit le bordereau + contrat par jour depuis les contrats de la personne
    const jours = buildJoursFromSemaine(data.jours, semaine);
    for (const j of jours) {
      const c = findContratForDate(best.contrats, j.date);
      if (c) j.contrat = formatContratValue(c);
    }
    // Filtre : on ne garde que les jours AVEC heures saisies
    const joursActifs = jours.filter(j => j.matin.debut || j.matin.fin || j.apresMidi.debut || j.apresMidi.fin);
    if (joursActifs.length === 0) {
      result.status = 'not_a_bordereau';
      result.reason = 'Aucun jour travaillé détecté après parsing';
      return result;
    }

    // Contrat par défaut = celui du 1er jour actif (fallback si une ligne est vide)
    const firstContrat = joursActifs.find(j => j.contrat)?.contrat || '';
    // Raison sociale : celle du contrat actif au 1er jour travaillé
    const firstDate = joursActifs[0].date;
    const firstContratObj = findContratForDate(best.contrats, firstDate) || best.contrats?.[0];
    const client = firstContratObj?.client || data.client || null;

    const bordereau = {
      nom: best.nom,
      prenom: best.prenom,
      matricule: best.matricule || best.matricule_notion || null,
      client,
      contratDefaut: firstContrat,
      reference: null,
      semaineDu: semaine,
      semaineAu: addDays(semaine, 6),
      jours: joursActifs,
    };

    // 6. Archive (save refuse si hash déjà présent côté worker)
    onStep?.('saving');
    try {
      const saved = await saveBordereau({
        bordereau, dayHoursFn: dayHours,
        csvPld: null,  // pas de CSV en batch, on fera le CSV de masse à l'export PLD (étape 4)
        source: 'ocr-batch',
        pdfFile: file,
        fileHash: result.hash,
      });
      result.status = 'ok';
      result.bordereauId = saved.id;
      return result;
    } catch (err) {
      if (/\b409\b/.test(err.message) && /duplicate/i.test(err.message)) {
        result.status = 'duplicate';
        result.reason = err.message;
        return result;
      }
      throw err;
    }
  } catch (err) {
    result.status = 'error';
    result.reason = err.message || String(err);
    result.details = err.stack;
    return result;
  }
}

// --- Orchestrateur batch ---
// files : File[]
// options : { moisReference, onFileUpdate(result), concurrency = 1 }
// Retourne : { results: [...], report: { ok, duplicates, notBordereau, noMatch, errors } }
export async function processBatch(files, { moisReference, onFileUpdate, concurrency = 1 } = {}) {
  const results = files.map((f) => ({
    filename: f.name, file: f, status: 'pending', step: null,
  }));

  // Pré-check dédup par lots de 50 hashs
  const hashMap = new Map();
  await Promise.all(files.map(async (f, i) => {
    try {
      const h = await sha256File(f);
      hashMap.set(i, h);
      results[i].hash = h;
    } catch {}
  }));
  const allHashes = [...hashMap.values()];
  let alreadyKnown = new Map();
  if (allHashes.length > 0) {
    try {
      const { known } = await checkHashes(allHashes);
      alreadyKnown = new Map(known.map(k => [k.hash, k]));
    } catch (e) {
      console.warn('check-hashes batch échoué', e);
    }
  }

  // Marque les duplicates sans appeler l'OCR
  for (let i = 0; i < files.length; i++) {
    const h = results[i].hash;
    if (h && alreadyKnown.has(h)) {
      const k = alreadyKnown.get(h);
      results[i].status = 'duplicate';
      results[i].bordereauId = k.bordereauId;
      results[i].reason = `Déjà archivé : #${k.bordereauId} (${k.prenom} ${k.nom}, semaine ${k.semaineDu})`;
      onFileUpdate?.(i, results[i]);
    }
  }

  // Traite en série les non-duplicates (OCR est coûteux, on évite le burst rate-limit)
  const queue = [];
  for (let i = 0; i < files.length; i++) {
    if (results[i].status === 'pending') queue.push(i);
  }

  async function worker() {
    while (queue.length > 0) {
      const i = queue.shift();
      if (i === undefined) return;
      results[i].status = 'processing';
      onFileUpdate?.(i, results[i]);
      const r = await processSingleFile(files[i], {
        moisReference,
        onStep: (step) => {
          results[i].step = step;
          onFileUpdate?.(i, results[i]);
        },
      });
      Object.assign(results[i], r);
      onFileUpdate?.(i, results[i]);
    }
  }

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);

  const report = {
    total: results.length,
    ok:            results.filter(r => r.status === 'ok').length,
    duplicates:    results.filter(r => r.status === 'duplicate').length,
    notBordereau:  results.filter(r => r.status === 'not_a_bordereau').length,
    noMatch:       results.filter(r => r.status === 'no_match').length,
    errors:        results.filter(r => r.status === 'error').length,
  };
  return { results, report };
}
