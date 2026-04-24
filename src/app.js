import { dayHours } from './time-split.js';
import { bordereauToRows, toCsv, isFrenchHoliday } from './csv-pld.js';
import { ocrBordereau } from './ocr.js';
import {
  getAuthToken, setAuthToken, getUserEmail, setUserEmail,
  saveBordereau, listBordereaux, rgpdExport, rgpdForget,
  importIntermediaires, matchIntermediaire, listIntermediaires,
  listSnapshots, snapshotDownloadUrl,
  sha256File, checkHashes,
  deleteBordereau, fetchPdfBlobUrl,
  getBordereau, updateBordereau,
  batchFetchBordereaux, batchExport,
} from './archive.js';
import { parseNotionCsv } from './parse-notion-csv.js';
import { extractZip, convertHeicFile, processBatch } from './batch.js';

const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];

const tbody = document.getElementById('days-body');
const lundiInput = document.getElementById('f-lundi');

function addDate(base, offset) {
  const d = new Date(base);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

function buildRows() {
  tbody.innerHTML = '';
  JOURS.forEach((nom, i) => {
    const tr = document.createElement('tr');
    tr.className = 'day-row';
    tr.dataset.index = i;
    tr.innerHTML = `
      <td class="day-label">${nom}</td>
      <td><input type="date" data-field="date"></td>
      <td><input type="time" data-field="matinDebut"></td>
      <td><input type="time" data-field="matinFin"></td>
      <td><input type="time" data-field="amDebut"></td>
      <td><input type="time" data-field="amFin"></td>
      <td><input type="text" data-field="contrat" placeholder="(défaut)"></td>
      <td><label class="ferie-toggle"><input type="checkbox" data-field="ferie"> férié</label></td>
      <td class="num" data-cell="ht">0.00</td>
      <td class="num" data-cell="hn">0.00</td>
      <td class="num" data-cell="total">0.00</td>
    `;
    tbody.appendChild(tr);
  });
}

function syncDates() {
  const lundi = lundiInput.value;
  if (!lundi) return;
  tbody.querySelectorAll('tr').forEach((tr, i) => {
    const date = addDate(lundi, i);
    tr.querySelector('[data-field=date]').value = date;
    // Auto-coche la case « férié » si c'est un jour férié FR (jamais de décoche auto
    // pour ne pas écraser un choix manuel sur un jour non-férié).
    if (isFrenchHoliday(date)) {
      const cb = tr.querySelector('[data-field=ferie]');
      if (cb && !cb.checked) cb.checked = true;
      tr.classList.add('auto-ferie');
    } else {
      tr.classList.remove('auto-ferie');
    }
  });
  // Si une personne est déjà sélectionnée, re-applique le contrat adapté à
  // la nouvelle date de chaque jour (cas où on change le lundi après match).
  applyPerDayContrats();
  recompute();
}

function collectBordereau() {
  const bordereau = {
    nom: document.getElementById('f-nom').value.trim(),
    prenom: document.getElementById('f-prenom').value.trim(),
    matricule: document.getElementById('f-matricule').value.trim(),
    contratDefaut: document.getElementById('f-contrat').value.trim(),
    client: document.getElementById('f-client').value.trim(),
    reference: document.getElementById('f-reference').value.trim(),
    jours: [],
  };
  const lundi = document.getElementById('f-lundi').value;
  if (lundi) {
    bordereau.semaineDu = lundi;
    const d = new Date(lundi); d.setDate(d.getDate() + 6);
    bordereau.semaineAu = d.toISOString().slice(0, 10);
  }
  tbody.querySelectorAll('tr').forEach((tr) => {
    const get = (f) => tr.querySelector(`[data-field=${f}]`).value;
    const ferie = tr.querySelector('[data-field=ferie]').checked;
    const date = get('date');
    if (!date) return;
    const jour = {
      date,
      matin: { debut: get('matinDebut'), fin: get('matinFin') },
      apresMidi: { debut: get('amDebut'), fin: get('amFin') },
      contrat: get('contrat'),
      ferie,
    };
    bordereau.jours.push(jour);
  });
  return bordereau;
}

function recompute() {
  const bordereau = collectBordereau();
  let totalHT = 0, totalHN = 0, totalMin = 0;
  const alerts = [];

  tbody.querySelectorAll('tr').forEach((tr) => {
    const get = (f) => tr.querySelector(`[data-field=${f}]`).value;
    const jour = {
      matin: { debut: get('matinDebut'), fin: get('matinFin') },
      apresMidi: { debut: get('amDebut'), fin: get('amFin') },
    };
    const h = dayHours(jour);
    tr.querySelector('[data-cell=ht]').textContent = h.jour.toFixed(2);
    tr.querySelector('[data-cell=hn]').textContent = h.nuit.toFixed(2);
    const totH = Math.floor(h.totalMin / 60);
    const totM = h.totalMin % 60;
    tr.querySelector('[data-cell=total]').textContent = h.totalMin ? `${totH}h${String(totM).padStart(2,'0')}` : '0.00';

    totalHT += h.jour;
    totalHN += h.nuit;
    totalMin += h.totalMin;

    // Alerte : journée > 12h
    if (h.totalMin > 12 * 60) {
      alerts.push(`${get('date') || 'Jour'} : ${totH}h${String(totM).padStart(2,'0')} travaillées (> 12h)`);
      tr.classList.add('alert');
    } else {
      tr.classList.remove('alert');
    }
    // Alerte : pause < 30 min entre matin et AM
    const mf = get('matinFin'), ad = get('amDebut');
    if (mf && ad) {
      const [h1, m1] = mf.split(':').map(Number);
      const [h2, m2] = ad.split(':').map(Number);
      const pause = (h2 * 60 + m2) - (h1 * 60 + m1);
      if (pause < 30 && pause > 0) {
        alerts.push(`${get('date') || 'Jour'} : pause de ${pause} min (< 30 min)`);
      }
    }
    // Marquage férié
    if (tr.querySelector('[data-field=ferie]').checked) {
      tr.classList.add('ferie');
    } else {
      tr.classList.remove('ferie');
    }
  });

  document.getElementById('sum-ht').textContent = totalHT.toFixed(2);
  document.getElementById('sum-hn').textContent = totalHN.toFixed(2);
  const totH = Math.floor(totalMin / 60);
  const totM = totalMin % 60;
  document.getElementById('sum-total').textContent = `${totH}h${String(totM).padStart(2,'0')}`;

  if (totalMin > 48 * 60) {
    alerts.push(`Semaine : ${totH}h${String(totM).padStart(2,'0')} (> 48h, plafond légal)`);
  }

  // Récap hebdo pour la section 5 (breakdown avant CSV)
  renderWeekBreakdown(bordereau);

  const ul = document.getElementById('alerts');
  if (alerts.length === 0) {
    ul.innerHTML = '<li class="small">Aucune</li>';
  } else {
    ul.innerHTML = alerts.map(a => `<li>${a}</li>`).join('');
  }
}

// ===== Paramètres export PLD (codes configurables, persistés localStorage) =====
const PLD_CODES_KEY = 'cameleons_pld_codes';
const DEFAULT_PLD_CODES = {
  total: 'HT', jour: 'HJ', nuit: 'HN',
  t1: 'HS1', t2: 'HS2',
  ferie: 'HF', dimanche: 'HD',
  cp: 'CP', rtt: 'RTT', am: 'AM',
};

export function getPldCodes() {
  try {
    const stored = localStorage.getItem(PLD_CODES_KEY);
    if (!stored) return { ...DEFAULT_PLD_CODES };
    return { ...DEFAULT_PLD_CODES, ...JSON.parse(stored) };
  } catch {
    return { ...DEFAULT_PLD_CODES };
  }
}
function setPldCodes(codes) {
  localStorage.setItem(PLD_CODES_KEY, JSON.stringify(codes));
}

// Calcule le breakdown hebdo (normales/T1/T2/férié/dimanche/nuit) affiché
// au-dessus du CSV. Même logique que csv-pld.js.bordereauToRows.
function renderWeekBreakdown(bordereau) {
  const box = document.getElementById('week-breakdown');
  if (!box) return;
  const jours = (bordereau.jours || [])
    .filter(j => j.date)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  let totalTravail = 0, normales = 0, t1 = 0, t2 = 0, ferie = 0, dimanche = 0, nuit = 0;
  let cumul = 0;
  for (const j of jours) {
    const h = dayHours(j);
    const total = (h.jour || 0) + (h.nuit || 0);
    if (total <= 0) continue;
    totalTravail += total;
    nuit += h.nuit || 0;
    const d = new Date(j.date + 'T00:00:00Z');
    const isDim = d.getUTCDay() === 0;
    const isFer = !!j.ferie || isFrenchHoliday(j.date);
    if (isDim) { dimanche += total; continue; }
    if (isFer) { ferie += total; continue; }
    let remain = total;
    const qN = Math.min(remain, Math.max(35 - cumul, 0));
    remain -= qN; cumul += qN; normales += qN;
    const qT1 = Math.min(remain, Math.max(43 - cumul, 0));
    remain -= qT1; cumul += qT1; t1 += qT1;
    if (remain > 0) { cumul += remain; t2 += remain; }
  }
  if (totalTravail === 0) { box.innerHTML = ''; return; }
  const c = getPldCodes();
  const line = (code, label, value, tone) => value > 0
    ? `<div class="bd-item ${tone}"><span class="bd-code">${code}</span><span class="bd-lbl">${label}</span><span class="bd-val">${value.toFixed(2)}</span></div>`
    : '';
  box.innerHTML = `
    <h3 style="margin:0 0 0.5rem;font-size:0.95rem">Récap semaine (ce qui sera dans le CSV)</h3>
    <div class="bd-grid">
      ${line(c.total,    'Heures travaillées (total)',     totalTravail, 'total')}
      ${line(c.jour,     'Heures normales (0→35h)',        normales,     'normal')}
      ${line(c.t1,       'Heures sup T1 (35→43h, 125%)',   t1,           'sup1')}
      ${line(c.t2,       'Heures sup T2 (>43h, 150%)',     t2,           'sup2')}
      ${line(c.ferie,    'Heures fériés',                  ferie,        'ferie')}
      ${line(c.dimanche, 'Heures dimanche (200%)',         dimanche,     'dim')}
      ${line(c.nuit,     'Complément heures de nuit',      nuit,         'nuit')}
    </div>
  `;
}

function generate() {
  const bordereau = collectBordereau();
  if (!bordereau.nom || !bordereau.prenom) {
    alert('Nom et Prénom obligatoires.');
    return null;
  }
  const c = getPldCodes();
  const rows = bordereauToRows(bordereau, dayHours, {
    codeTotal: c.total,
    codeNormales: c.jour,
    codeNuit: c.nuit,
    codeSupT1: c.t1,
    codeSupT2: c.t2,
    codeFerie: c.ferie,
    codeDimanche: c.dimanche,
  });
  if (rows.length === 0) {
    alert('Aucune heure saisie.');
    return null;
  }
  // Marquage férié : on ajoute un commentaire en référence (PLD gère la majoration)
  tbody.querySelectorAll('tr').forEach((tr) => {
    const date = tr.querySelector('[data-field=date]').value;
    const ferie = tr.querySelector('[data-field=ferie]').checked;
    if (ferie && date) {
      rows.forEach(r => {
        if (r.date === date || r.date === date.replace(/-/g, '')) {
          r.reference = (r.reference || '') + ' FERIE';
        }
      });
    }
  });
  const csv = toCsv(rows);
  document.getElementById('csv-output').textContent = csv;
  return { csv, bordereau };
}

document.getElementById('btn-generate').addEventListener('click', generate);

document.getElementById('btn-download').addEventListener('click', () => {
  const r = generate();
  if (!r) return;
  const { bordereau } = r;
  const date = new Date().toISOString().slice(0, 10);
  const fname = `bordereau_${bordereau.nom}_${bordereau.prenom}_${date}.csv`.replace(/\s+/g, '_');
  const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fname;
  a.click();
});

document.getElementById('btn-copy').addEventListener('click', async () => {
  const r = generate();
  if (!r) return;
  await navigator.clipboard.writeText(r.csv);
  const btn = document.getElementById('btn-copy');
  const old = btn.textContent;
  btn.textContent = 'Copié ✓';
  setTimeout(() => btn.textContent = old, 1500);
});

lundiInput.addEventListener('change', syncDates);
tbody.addEventListener('input', recompute);
tbody.addEventListener('change', recompute);

// --- Auth équipe ---
const authTokenInput = document.getElementById('f-auth-token');
const userEmailInput = document.getElementById('f-user-email');
const tokenBadge = document.getElementById('token-saved');
const emailBadge = document.getElementById('email-saved');

function showBadge(el, text = '✓ enregistré') {
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 1500);
}

authTokenInput.value = getAuthToken();
userEmailInput.value = getUserEmail();
if (getAuthToken()) { tokenBadge.textContent = '✓ déjà enregistré'; tokenBadge.classList.add('show'); }
if (getUserEmail()) { emailBadge.textContent = '✓ déjà enregistré'; emailBadge.classList.add('show'); }

// Sauvegarde à chaque frappe (plus juste au blur)
authTokenInput.addEventListener('input', () => {
  setAuthToken(authTokenInput.value.trim());
  showBadge(tokenBadge);
});
userEmailInput.addEventListener('input', () => {
  setUserEmail(userEmailInput.value.trim());
  showBadge(emailBadge);
});

document.getElementById('btn-clear-auth').addEventListener('click', () => {
  if (!confirm('Effacer le token et l\'email de ce navigateur ?')) return;
  setAuthToken('');
  setUserEmail('');
  authTokenInput.value = '';
  userEmailInput.value = '';
  tokenBadge.classList.remove('show');
  emailBadge.classList.remove('show');
});

// --- Import CSV Notion ---
const notionInput = document.getElementById('f-notion-csv');
const notionStatus = document.getElementById('notion-status');
async function fileToBase64Text(file) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

notionInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!getAuthToken()) {
    notionStatus.textContent = 'Renseigne ton token équipe avant d\'importer (section 0).';
    notionStatus.style.color = '#C55A3A';
    return;
  }
  notionStatus.textContent = `Lecture de ${file.name}...`;
  notionStatus.style.color = 'var(--c-text-muted)';
  try {
    const text = await file.text();
    const csvRaw = await fileToBase64Text(file);
    const { rows, errors } = parseNotionCsv(text);
    if (errors.length) console.warn('Erreurs parsing CSV :', errors);
    if (!rows.length) {
      notionStatus.textContent = `Aucune ligne exploitable. ${errors.length} erreur(s). Voir console.`;
      notionStatus.style.color = '#C55A3A';
      return;
    }
    notionStatus.textContent = `${rows.length} ligne(s) parsée(s). Import + archivage en cours...`;
    const res = await importIntermediaires({ rows, csvRaw, filename: file.name, errors });
    const s = res.stats;
    notionStatus.textContent = `✓ Import OK (snapshot #${res.snapshotId}) : ${s.intermediaires.inserted} nouveau(x) + ${s.intermediaires.updated} mis à jour · ${s.contrats.inserted + s.contrats.updated} contrat(s).${errors.length ? ' ' + errors.length + ' ligne(s) ignorée(s).' : ''}`;
    notionStatus.style.color = 'var(--c-success)';
    // Rafraîchir automatiquement l'historique s'il est ouvert
    const histBox = document.getElementById('imports-history');
    if (histBox && histBox.style.display === 'block') refreshHistoryImports();
  } catch (err) {
    console.error(err);
    notionStatus.textContent = `Erreur : ${err.message}`;
    notionStatus.style.color = '#C55A3A';
  }
  e.target.value = '';
});

let cachedInterimaires = [];

// Pour le matching : on considère qu'un bordereau est "valide" si nom+prénom
// correspondent EXACTEMENT à quelqu'un en base. Sinon on force la sélection.
let currentMatchedIntermId = null;
// Contrats de la personne actuellement sélectionnée — utilisés pour pré-remplir
// la colonne « Contrat » de chaque ligne jour selon la date du jour.
let currentPersonContrats = [];

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

function applyPerDayContrats() {
  if (!currentPersonContrats || currentPersonContrats.length === 0) return;
  tbody.querySelectorAll('tr').forEach((tr) => {
    const date = tr.querySelector('[data-field=date]').value;
    const contratInput = tr.querySelector('[data-field=contrat]');
    if (!date || !contratInput) return;
    const c = findContratForDate(currentPersonContrats, date);
    if (c) {
      contratInput.value = formatContratValue(c);
      contratInput.title = `${c.client || ''} — ${c.date_debut || c.debut || '?'} → ${c.date_fin || c.fin || 'en cours'}`;
      contratInput.dataset.autoContrat = '1';
    } else if (contratInput.dataset.autoContrat) {
      // Une date précédente avait auto-rempli, mais plus de contrat actif :
      // on vide pour qu'on reprenne le contratDefaut.
      contratInput.value = '';
      delete contratInput.dataset.autoContrat;
      contratInput.title = '';
    }
  });
}

async function ensureInterimairesLoaded() {
  if (cachedInterimaires.length > 0) return cachedInterimaires;
  if (!getAuthToken()) return [];
  try {
    const { intermediaires } = await listIntermediaires(2000);
    cachedInterimaires = intermediaires;
    return intermediaires;
  } catch (e) {
    console.warn('Impossible de charger la base intérimaires', e);
    return [];
  }
}

function findExactMatch(nom, prenom) {
  const nomN = (nom || '').trim().toLowerCase();
  const prenomN = (prenom || '').trim().toLowerCase();
  if (!nomN || !prenomN) return null;
  return cachedInterimaires.find(i =>
    (i.nom || '').toLowerCase() === nomN &&
    (i.prenom || '').toLowerCase() === prenomN
  ) || null;
}

function updateMatchIndicator() {
  const nom = document.getElementById('f-nom').value;
  const prenom = document.getElementById('f-prenom').value;
  const match = findExactMatch(nom, prenom);
  const badge = document.getElementById('match-indicator');
  if (!badge) return;
  if (match) {
    currentMatchedIntermId = match.id;
    badge.innerHTML = `<span style="color:var(--c-success)">✓ ${match.prenom} ${match.nom} trouvé en base</span>`;
    document.getElementById('btn-change-person').style.display = 'inline-block';
  } else {
    currentMatchedIntermId = null;
    badge.innerHTML = `<span style="color:var(--c-danger)">⚠ Personne non trouvée en base — choisir obligatoirement</span>`;
    document.getElementById('btn-change-person').style.display = 'inline-block';
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function durationDays(debut, fin) {
  if (!debut) return null;
  const d1 = new Date(debut);
  const d2 = fin ? new Date(fin) : new Date();
  const days = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  if (days < 0) return null;
  if (days >= 365) {
    const years = (days / 365).toFixed(1);
    return `${years} an${parseFloat(years) > 1 ? 's' : ''}`;
  }
  if (days >= 30) {
    const months = Math.round(days / 30);
    return `${months} mois`;
  }
  return `${days} j`;
}

function contractStatus(contrat, today) {
  if (!contrat) return { cls: 'neutral', label: 'aucun contrat' };
  if (!contrat.fin) return { cls: 'active', label: 'en cours' };
  if (contrat.fin >= today) {
    const daysLeft = Math.round((new Date(contrat.fin) - new Date(today)) / (1000 * 60 * 60 * 24));
    if (daysLeft <= 14) return { cls: 'soon', label: `fin dans ${daysLeft}j` };
    return { cls: 'active', label: 'actif' };
  }
  return { cls: 'expired', label: 'expiré' };
}

function renderInterimList(list) {
  const grid = document.getElementById('interm-grid');
  if (!list.length) {
    grid.innerHTML = '<p class="small">Aucun intérimaire trouvé.</p>';
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  grid.innerHTML = list.map(i => {
    const contrats = (i.contrats || []).slice();
    const principal = contrats[0]; // déjà trié par fin desc
    const status = contractStatus(principal, today);
    const autres = contrats.slice(1);
    return `
      <div class="interm-card" data-search="${(i.prenom + ' ' + i.nom + ' ' + (principal?.client || '')).toLowerCase()}">
        <div class="name">${i.prenom} ${i.nom}
          ${i.matricule_notion ? `<span class="badge neutral">#${i.matricule_notion}</span>` : ''}
        </div>
        ${principal ? `
          <div class="contrat-main">
            <div class="client"><strong>${principal.client || '—'}</strong></div>
            <div class="contrat-dates small">
              ${formatDate(principal.debut)} → ${principal.fin ? formatDate(principal.fin) : 'en cours'}
              ${durationDays(principal.debut, principal.fin) ? `<span class="badge neutral">${durationDays(principal.debut, principal.fin)}</span>` : ''}
            </div>
            <div class="contrat-meta">
              <span><span class="dot ${status.cls}"></span>${status.label}</span>
              <span class="small">N°${principal.numero}${principal.avenant > 0 ? '-av.' + principal.avenant : ''}</span>
            </div>
          </div>
          ${autres.length ? `
            <details class="contrats-autres">
              <summary>+ ${autres.length} autre${autres.length > 1 ? 's' : ''} contrat${autres.length > 1 ? 's' : ''}</summary>
              <ul class="contrats-list">
                ${autres.map(c => {
                  const s = contractStatus(c, today);
                  return `<li>
                    <div><strong>${c.client || '—'}</strong> <span class="small">N°${c.numero}${c.avenant > 0 ? '-av.' + c.avenant : ''}</span></div>
                    <div class="small">${formatDate(c.debut)} → ${c.fin ? formatDate(c.fin) : 'en cours'} · <span class="dot ${s.cls}"></span>${s.label}</div>
                  </li>`;
                }).join('')}
              </ul>
            </details>
          ` : ''}
        ` : `<div class="small" style="margin-top:0.5rem">Aucun contrat enregistré.</div>`}
      </div>
    `;
  }).join('');
}

function renderInterimStats(list) {
  const today = new Date().toISOString().slice(0, 10);
  let actifs = 0, expires = 0;
  for (const i of list) {
    for (const c of (i.contrats || [])) {
      if (!c.fin || c.fin >= today) actifs++;
      else expires++;
    }
  }
  document.getElementById('stat-interm').textContent = list.length;
  document.getElementById('stat-actifs').textContent = actifs;
  document.getElementById('stat-expires').textContent = expires;
}

document.getElementById('btn-list-interm').addEventListener('click', async () => {
  if (!getAuthToken()) { notionStatus.textContent = 'Token requis.'; notionStatus.style.color = '#d70015'; return; }
  notionStatus.textContent = 'Chargement...';
  notionStatus.style.color = 'var(--c-text-muted)';
  try {
    const { intermediaires } = await listIntermediaires(1000);
    cachedInterimaires = intermediaires;
    document.getElementById('interm-list').style.display = 'block';
    renderInterimStats(intermediaires);
    renderInterimList(intermediaires);
    notionStatus.textContent = `${intermediaires.length} intérimaire(s) affiché(s).`;
    notionStatus.style.color = 'var(--c-success)';
  } catch (err) {
    notionStatus.textContent = `Erreur : ${err.message}`;
    notionStatus.style.color = '#C55A3A';
  }
});

// Historique des imports
const MOIS_LONG = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];

function formatImportDate(isoDate) {
  const d = new Date(isoDate.replace(' ', 'T') + 'Z');
  const jour = String(d.getDate()).padStart(2, '0');
  const mois = MOIS_LONG[d.getMonth()];
  const annee = d.getFullYear();
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${jour} ${mois} ${annee} à ${h}h${min}`;
}

function monthKey(isoDate) {
  const d = new Date(isoDate.replace(' ', 'T') + 'Z');
  return `${MOIS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

async function refreshHistoryImports() {
  const list = document.getElementById('imports-list');
  list.innerHTML = '<p class="small">Chargement...</p>';
  try {
    const { snapshots } = await listSnapshots();
    if (!snapshots.length) {
      list.innerHTML = '<p class="small">Aucun import encore. Importez un CSV pour commencer l\'historique.</p>';
      return;
    }
    // Groupement par mois
    const byMonth = {};
    for (const s of snapshots) {
      const k = monthKey(s.import_date);
      if (!byMonth[k]) byMonth[k] = [];
      byMonth[k].push(s);
    }
    const html = Object.entries(byMonth).map(([mois, snaps]) => `
      <details class="month-group" open>
        <summary><strong>${mois}</strong> <span class="small">· ${snaps.length} import${snaps.length > 1 ? 's' : ''}</span></summary>
        <div class="snapshots-list">
          ${snaps.map(s => `
            <div class="snapshot-card">
              <div class="snapshot-header">
                <strong>${formatImportDate(s.import_date)}</strong>
                <span class="small">#${s.id}</span>
              </div>
              <div class="snapshot-meta small">
                <span>${s.nb_lignes_csv} ligne${s.nb_lignes_csv > 1 ? 's' : ''} CSV</span>
                ·
                <span class="badge jour">+${s.nb_inter_inserted} intérim</span>
                <span class="badge neutral">${s.nb_inter_updated} maj</span>
                ·
                <span class="badge jour">+${s.nb_contrats_inserted} contrat${s.nb_contrats_inserted > 1 ? 's' : ''}</span>
                <span class="badge neutral">${s.nb_contrats_updated} maj</span>
              </div>
              <div class="snapshot-footer">
                <span class="small">par ${s.user_email || 'inconnu'}</span>
                ${s.has_csv ? `<button class="snap-download" data-id="${s.id}" data-name="${(s.filename || 'import-' + s.id + '.csv').replace(/"/g, '&quot;')}">Télécharger CSV</button>` : '<span class="small">(pas de CSV archivé)</span>'}
              </div>
            </div>
          `).join('')}
        </div>
      </details>
    `).join('');
    list.innerHTML = html;
    // Active les boutons de téléchargement
    list.querySelectorAll('.snap-download').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const name = btn.dataset.name;
        btn.disabled = true;
        btn.textContent = 'Téléchargement...';
        try {
          const res = await fetch(snapshotDownloadUrl(id), {
            headers: {
              'X-Auth-Token': getAuthToken(),
              'X-User-Email': getUserEmail(),
            },
          });
          if (!res.ok) throw new Error(`${res.status}`);
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = name;
          a.click();
          URL.revokeObjectURL(url);
          btn.textContent = 'Télécharger CSV';
        } catch (err) {
          btn.textContent = `Erreur ${err.message}`;
        } finally {
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    list.innerHTML = `<p class="small" style="color:#C55A3A">Erreur : ${err.message}</p>`;
  }
}

document.getElementById('btn-list-imports').addEventListener('click', () => {
  const box = document.getElementById('imports-history');
  const visible = box.style.display === 'block';
  box.style.display = visible ? 'none' : 'block';
  if (!visible) refreshHistoryImports();
});

// Filtrage en direct
document.getElementById('interm-filter').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  if (!q) { renderInterimList(cachedInterimaires); return; }
  const filtered = cachedInterimaires.filter(i =>
    `${i.prenom} ${i.nom}`.toLowerCase().includes(q) ||
    (i.matricule_notion || '').toLowerCase().includes(q)
  );
  renderInterimList(filtered);
});

// Stocke le dernier fichier uploadé pour pouvoir l'archiver en même temps
let lastUploadedFile = null;
// Hash SHA-256 du dernier fichier (pour dédup et save)
let lastUploadedHash = null;
// Si on est en train d'éditer un bordereau existant (vs en créer un nouveau)
let editingBordereauId = null;

// Modal « doublon détecté » — remplace confirm() natif pour avoir des boutons explicites.
// Renvoie une Promise qui résout à true (relancer) ou false (ne pas relancer).
function showDuplicateModal({ prenom, nom, semaineDu, bordereauId, status }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-card">
        <h3>⚠ Fichier déjà archivé</h3>
        <p class="small">Ce PDF/image a déjà été traité et enregistré :</p>
        <div class="modal-info">
          <div><strong>${prenom || '?'} ${nom || '?'}</strong></div>
          <div class="small">Semaine du ${semaineDu || '?'}</div>
          <div class="small">Bordereau #${bordereauId} · statut : ${status || '?'}</div>
        </div>
        <p class="small">L'archivage sera refusé tant que le fichier n'est pas modifié.
           Tu peux quand même relancer l'OCR pour vérifier la lecture.</p>
        <div class="modal-actions">
          <button class="modal-btn secondary" data-answer="skip">Ne pas relancer</button>
          <button class="modal-btn" data-answer="rerun">Relancer l'OCR</button>
        </div>
      </div>
    `;
    const cleanup = (answer) => {
      document.body.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
      resolve(answer === 'rerun');
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cleanup('skip');
      else if (e.key === 'Enter') cleanup('rerun');
    };
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup('skip');
      const btn = e.target.closest('[data-answer]');
      if (btn) cleanup(btn.dataset.answer);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}

// --- OCR ---
const JOUR_INDEX = { lundi: 0, mardi: 1, mercredi: 2, jeudi: 3, vendredi: 4, samedi: 5, dimanche: 6 };

function setStatus(msg, isError = false) {
  const el = document.getElementById('ocr-status');
  el.textContent = msg;
  el.style.color = isError ? '#d70015' : '#0071e3';
}

function clearForm() {
  document.getElementById('f-nom').value = '';
  document.getElementById('f-prenom').value = '';
  document.getElementById('f-matricule').value = '';
  document.getElementById('f-client').value = '';
  tbody.querySelectorAll('tr').forEach(tr => {
    ['matinDebut', 'matinFin', 'amDebut', 'amFin'].forEach(f => {
      const el = tr.querySelector(`[data-field=${f}]`);
      if (el) { el.value = ''; delete el.dataset.doute; }
    });
    const contrat = tr.querySelector('[data-field=contrat]');
    if (contrat && contrat.dataset.autoContrat) {
      contrat.value = '';
      contrat.title = '';
      delete contrat.dataset.autoContrat;
    }
    const ferie = tr.querySelector('[data-field=ferie]');
    if (ferie) ferie.checked = false;
  });
  delete document.getElementById('f-nom').dataset.doute;
  delete document.getElementById('f-prenom').dataset.doute;
  delete document.getElementById('f-client').dataset.doute;
  currentPersonContrats = [];
  recompute();
}

// === Bordereau de présence (mensuel) → semaine hebdo exploitable ===
// Etat courant si un bordereau de présence est chargé : on stocke le mois
// complet et on navigue semaine par semaine via des boutons dédiés.
let presenceState = null;  // { nom, prenom, client, mois, annee, presenceDays, weekIndex }

function weeksOfMonth(annee, mois) {
  // Retourne toutes les semaines (lundi→dimanche) qui TOUCHENT ce mois.
  // Peut déborder le mois précédent ou suivant (on veut tous les jours de la
  // semaine où tombe au moins un jour du mois).
  const first = new Date(Date.UTC(annee, mois - 1, 1));
  const last  = new Date(Date.UTC(annee, mois, 0));  // dernier jour du mois
  const firstMonday = new Date(first);
  const dow = firstMonday.getUTCDay();
  firstMonday.setUTCDate(firstMonday.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
  const weeks = [];
  let cur = new Date(firstMonday);
  while (cur <= last) {
    weeks.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return weeks;
}

// Pour une semaine donnée (lundi ISO), extrait les 7 jours de présence
// correspondants depuis presenceDays (mapping sur day+mois).
function buildJoursFromPresence(lundiIso, mois, annee, presenceDays) {
  const JOURS = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'];
  const byDay = new Map();
  for (const d of (presenceDays || [])) byDay.set(d.day, d);
  const out = [];
  const d = new Date(lundiIso + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    const iso = d.toISOString().slice(0, 10);
    const m = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const presence = (m === mois && d.getUTCFullYear() === annee) ? byDay.get(day) : null;
    // Demi-journée = 3.5h. Matin conventionnel = 09:00-12:30, après-midi = 14:00-17:30.
    const j = {
      jour: JOURS[i],
      date: iso,
      matinDebut: presence?.matin ? '09:00' : null,
      matinFin:   presence?.matin ? '12:30' : null,
      amDebut:    presence?.apresMidi ? '14:00' : null,
      amFin:      presence?.apresMidi ? '17:30' : null,
      ferie: false,
      doutes: presence?.doutes || [],
    };
    out.push(j);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function renderPresenceControls() {
  let bar = document.getElementById('presence-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'presence-bar';
    bar.className = 'presence-bar';
    document.getElementById('ocr-card').after(bar);
  }
  if (!presenceState) { bar.style.display = 'none'; return; }
  const { mois, annee, weekIndex, weeks, presenceDays } = presenceState;
  const nbPresent = (presenceDays || []).filter(d => d.matin || d.apresMidi).length;
  bar.style.display = 'block';
  bar.innerHTML = `
    <div class="presence-header">
      <strong>📅 Bordereau de présence</strong> · ${MOIS_LONG[mois - 1]} ${annee} · ${nbPresent} jour(s) travaillé(s)
    </div>
    <p class="small">Semaine affichée : <strong>${weeks[weekIndex]}</strong> (${weekIndex + 1} / ${weeks.length}).
       Archive chaque semaine séparément.</p>
    <div class="presence-actions">
      <button class="secondary" id="btn-presence-prev" ${weekIndex === 0 ? 'disabled' : ''}>← Semaine précédente</button>
      <button class="secondary" id="btn-presence-next" ${weekIndex >= weeks.length - 1 ? 'disabled' : ''}>Semaine suivante →</button>
    </div>
  `;
  document.getElementById('btn-presence-prev').onclick = () => switchPresenceWeek(-1);
  document.getElementById('btn-presence-next').onclick = () => switchPresenceWeek(+1);
}

function switchPresenceWeek(delta) {
  if (!presenceState) return;
  const next = presenceState.weekIndex + delta;
  if (next < 0 || next >= presenceState.weeks.length) return;
  presenceState.weekIndex = next;
  applyPresenceWeek();
}

function applyPresenceWeek() {
  if (!presenceState) return;
  const { weekIndex, weeks, mois, annee, presenceDays } = presenceState;
  const lundi = weeks[weekIndex];
  const jours = buildJoursFromPresence(lundi, mois, annee, presenceDays);
  // Remet les données dans le formulaire existant
  clearForm();
  document.getElementById('f-nom').value = presenceState.nom || '';
  document.getElementById('f-prenom').value = presenceState.prenom || '';
  if (presenceState.client) document.getElementById('f-client').value = presenceState.client;
  lundiInput.value = lundi;
  syncDates();
  for (const j of jours) {
    const idx = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'].indexOf(j.jour);
    if (idx < 0) continue;
    const tr = tbody.querySelectorAll('tr')[idx];
    if (!tr) continue;
    ['matinDebut','matinFin','amDebut','amFin'].forEach(f => {
      const el = tr.querySelector(`[data-field=${f}]`);
      if (el && j[f]) el.value = j[f];
    });
  }
  // Re-applique contrat par jour si personne déjà matchée
  applyPerDayContrats();
  recompute();
  // Si un intérimaire matché cache currentPersonContrats, on réapplique
  // le matching dès maintenant (utile quand la personne a 1 seul contrat).
  renderPresenceControls();
}

function applyOcrResult(data) {
  clearForm();
  const doutesGlobaux = new Set(data.doutesGlobaux || []);

  // === Format B : bordereau de présence (mensuel) ===
  if (data.type === 'presence' && data.presenceDays) {
    const mois = data.mois;
    const annee = data.annee;
    if (!mois || !annee) {
      setStatus('⚠ Bordereau de présence détecté mais mois/année manquants.', true);
      return;
    }
    const weeks = weeksOfMonth(annee, mois);
    // Première semaine qui contient au moins un jour travaillé
    let firstIdx = 0;
    for (let i = 0; i < weeks.length; i++) {
      const jours = buildJoursFromPresence(weeks[i], mois, annee, data.presenceDays);
      if (jours.some(j => j.matinDebut || j.amDebut)) { firstIdx = i; break; }
    }
    presenceState = {
      nom: data.nom, prenom: data.prenom, client: data.client,
      mois, annee, presenceDays: data.presenceDays,
      weeks, weekIndex: firstIdx,
    };
    applyPresenceWeek();
    return;
  }
  presenceState = null;
  renderPresenceControls();
  const markDoubt = (id, field) => {
    const el = document.getElementById(id);
    if (el && doutesGlobaux.has(field)) el.dataset.doute = '1';
    else if (el) delete el.dataset.doute;
  };
  if (data.nom) document.getElementById('f-nom').value = data.nom;
  if (data.prenom) document.getElementById('f-prenom').value = data.prenom;
  if (data.client) document.getElementById('f-client').value = data.client;
  markDoubt('f-nom', 'nom');
  markDoubt('f-prenom', 'prenom');
  markDoubt('f-client', 'client');
  if (data.semaineDu) {
    lundiInput.value = data.semaineDu;
    syncDates();
    markDoubt('f-lundi', 'semaineDu');
  }
  for (const j of data.jours || []) {
    const idx = JOUR_INDEX[(j.jour || '').toLowerCase()];
    if (idx === undefined) continue;
    const tr = tbody.querySelectorAll('tr')[idx];
    if (!tr) continue;
    const setField = (field, value, douteux) => {
      const input = tr.querySelector(`[data-field=${field}]`);
      if (!input) return;
      if (value !== null && value !== undefined && value !== '') {
        input.value = value;
        if (douteux) input.dataset.doute = '1';
        else delete input.dataset.doute;
      }
    };
    const doutes = new Set(j.doutes || []);
    if (j.date) setField('date', j.date, doutes.has('date'));
    setField('matinDebut', j.matinDebut, doutes.has('matinDebut'));
    setField('matinFin', j.matinFin, doutes.has('matinFin'));
    setField('amDebut', j.amDebut, doutes.has('amDebut'));
    setField('amFin', j.amFin, doutes.has('amFin'));
    if (j.ferie) tr.querySelector('[data-field=ferie]').checked = true;
  }
  recompute();
}

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('f-file');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => {
  if (e.target.files[0]) handleFile(e.target.files[0]);
});

// Ramène une date ISO au lundi de sa semaine (dim -6, lun 0, mar -1, mer -2, ...)
function snapToMonday(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return null;
  const dow = d.getUTCDay(); // 0=dim, 1=lun...
  const offset = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// Lundi de la semaine qui contient le 1er du mois de référence
// (utile quand le 1er tombe en milieu de semaine : ex. avril 2026, 1er = mercredi)
function mondayOfFirstWeek(moisReference) {
  if (!moisReference) return null;
  const [y, m] = moisReference.split('-').map(Number);
  if (!y || !m) return null;
  const iso = `${y}-${String(m).padStart(2, '0')}-01`;
  return snapToMonday(iso);
}

// true si au moins un jour (lundi..dimanche) tombe dans le mois de référence
function weekOverlapsMonth(lundiIso, moisReference) {
  if (!lundiIso || !moisReference) return false;
  const d = new Date(lundiIso + 'T00:00:00Z');
  for (let i = 0; i < 7; i++) {
    if (d.toISOString().slice(0, 7) === moisReference) return true;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return false;
}

// === Side preview : PDF/image collé à droite pour vérif pendant édition ===
let sidePreviewUrl = null;
function openSidePreview(file) {
  if (!file) return;
  if (sidePreviewUrl) URL.revokeObjectURL(sidePreviewUrl);
  sidePreviewUrl = URL.createObjectURL(file);
  const aside = document.getElementById('side-preview');
  const body = document.getElementById('side-preview-body');
  document.getElementById('side-preview-name').textContent = file.name;
  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  body.innerHTML = isPdf
    ? `<iframe src="${sidePreviewUrl}" class="side-preview-iframe"></iframe>`
    : `<img src="${sidePreviewUrl}" class="side-preview-img" alt="">`;
  aside.style.display = 'flex';
  document.body.classList.add('with-side-preview');
}
function closeSidePreview() {
  if (sidePreviewUrl) { URL.revokeObjectURL(sidePreviewUrl); sidePreviewUrl = null; }
  document.getElementById('side-preview').style.display = 'none';
  document.body.classList.remove('with-side-preview');
}
document.getElementById('side-preview-close').addEventListener('click', closeSidePreview);
document.getElementById('side-preview-toggle').addEventListener('click', () => {
  document.getElementById('side-preview').classList.toggle('expanded');
});

async function handleFile(file) {
  lastUploadedFile = file;
  lastUploadedHash = null;
  openSidePreview(file);
  const moisReference = document.getElementById('f-mois-ref').value || null;

  // 1. Hash SHA-256 du fichier avant tout — permet de skip l'OCR si déjà traité
  setStatus(`Calcul du hash de ${file.name}...`);
  try {
    lastUploadedHash = await sha256File(file);
  } catch (e) {
    console.warn('Hash échoué', e);
  }

  // 2. Si on est authentifié, check côté serveur si ce hash existe déjà
  if (lastUploadedHash && getAuthToken()) {
    try {
      const { known } = await checkHashes([lastUploadedHash]);
      if (known.length > 0) {
        const k = known[0];
        const rerun = await showDuplicateModal(k);
        if (!rerun) {
          setStatus(`Fichier ignoré (déjà archivé sous id=${k.bordereauId}).`, false);
          return;
        }
      }
    } catch (e) {
      console.warn('Check-hashes échoué, on continue', e);
    }
  }

  setStatus(`OCR en cours sur ${file.name}...`);
  try {
    const data = await ocrBordereau(file, { moisReference });

    // 1. Normalise semaineDu au lundi de sa semaine (OCR peut lire une date
    //    mid-week, ex. 2026-04-01 qui est un mercredi → snap au lundi 2026-03-30).
    const originalSemaineDu = data.semaineDu;
    let snapped = snapToMonday(data.semaineDu);

    // 2. Si la semaine obtenue ne touche pas le mois de référence (ou date absente),
    //    fallback sur le lundi de la semaine qui contient le 1er du mois.
    if (moisReference && (!snapped || !weekOverlapsMonth(snapped, moisReference))) {
      snapped = mondayOfFirstWeek(moisReference);
    }

    if (snapped && snapped !== originalSemaineDu) {
      data.semaineDu = snapped;
      data.doutesGlobaux = Array.from(new Set([...(data.doutesGlobaux || []), 'semaineDu']));
      // Les dates par jour calculées par l'OCR étaient alignées sur l'ancienne date :
      // on les efface pour que syncDates les reconstruise proprement.
      for (const j of (data.jours || [])) j.date = null;
    } else if (snapped) {
      data.semaineDu = snapped;
    }
    applyOcrResult(data);
    const nbDoutesJours = (data.jours || []).reduce((n, j) => n + (j.doutes?.length || 0), 0);
    const nbDoutesGlob = (data.doutesGlobaux || []).length;
    const total = nbDoutesJours + nbDoutesGlob;
    const joursRemplis = (data.jours || []).filter(j => j.matinDebut || j.matinFin || j.amDebut || j.amFin).length;
    setStatus(`OCR terminé : ${joursRemplis} jour(s) travaillé(s), ${total} valeur(s) en rouge à vérifier. Recherche du contrat…`);

    // Auto-correction nom/prénom/contrat depuis la base intérimaires
    if (getAuthToken()) {
      try {
        const q = `${data.prenom || ''} ${data.nom || ''}`.trim();
        const date = data.semaineDu || document.getElementById('f-lundi').value || null;
        if (q || data.nom || data.prenom) {
          const { matches } = await matchIntermediaire({
            q, nom: data.nom, prenom: data.prenom, date, limit: 10,
          });
          applyInterimaireMatch(matches, { q, date, nomOcr: data.nom, prenomOcr: data.prenom });
        }
      } catch (e) {
        console.warn('Match intérimaire échoué', e);
      }
    }
  } catch (err) {
    console.error(err);
    setStatus(`Erreur OCR : ${err.message}`, true);
  }
}

async function applyInterimaireMatch(matches, { q, date, nomOcr, prenomOcr }) {
  const statusEl = document.getElementById('ocr-status');
  const SCORE_AUTO = 0.80;

  const best = matches && matches[0];

  if (best && best.score >= SCORE_AUTO) {
    applySelectedInterimaire(best, { date });
    const contrats = best.contrats || [];
    const isActiveOn = (c, iso) => {
      const debut = c.date_debut || c.debut;
      const fin   = c.date_fin   || c.fin;
      return (!debut || debut <= iso) && (!fin || fin >= iso);
    };
    const iso = date || new Date().toISOString().slice(0, 10);
    const actifs = contrats.filter(c => isActiveOn(c, iso));

    if (actifs.length === 1) {
      const c = actifs[0];
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} (match ${Math.round(best.score * 100)}%) — Contrat ${c.numero_contrat}${c.avenant > 0 ? ' av.' + c.avenant : ''} chez ${c.client}.`;
      statusEl.style.color = 'var(--c-success)';
    } else if (actifs.length > 1) {
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} trouvé. ${actifs.length} contrats actifs → choisir ci-dessous.`;
      statusEl.style.color = 'var(--c-success)';
    } else if (contrats.length > 0) {
      const r = contrats[0];
      statusEl.textContent = `⚠ ${best.prenom} ${best.nom} trouvé — aucun contrat actif${date ? ` le ${date}` : ''}. Dernier connu : ${r.client || '?'} (${r.date_debut || '?'} → ${r.date_fin || '?'}) — à vérifier.`;
      statusEl.style.color = 'var(--c-warn)';
    } else {
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} trouvé mais aucun contrat en base.`;
      statusEl.style.color = 'var(--c-warn)';
    }
    return;
  }

  // Pas de match fiable : propose les candidats au signal fort (≥ 50%).
  // Avec le cross-match ajouté, les vrais candidats ont un score ≥ 0.85 ;
  // en-dessous de 0.50 c'est du bruit qui déclenche trop de propositions.
  const candidates = (matches || []).filter(m => m.score >= 0.50);
  if (candidates.length > 0) {
    showSmartChooser(candidates, { q, date, nomOcr, prenomOcr });
    statusEl.textContent = `Correspondances partielles trouvées — choisis ci-dessous ou affiche toute la base.`;
    statusEl.style.color = 'var(--c-warn)';
    return;
  }

  // Vraiment rien : on bascule direct sur la base complète
  statusEl.textContent = `Aucun match. Sélectionne l'intérimaire dans la base :`;
  statusEl.style.color = 'var(--c-danger)';
  await ensureInterimairesLoaded();
  showFullBaseChooser({ q, date });
}

// Chooser "intelligent" : affiche les candidats partiels en expliquant
// POURQUOI chacun est proposé (prénom OK / nom OK / partiel)
function showSmartChooser(candidates, { q, date }) {
  let box = document.getElementById('match-chooser');
  if (!box) {
    box = document.createElement('div');
    box.id = 'match-chooser';
    box.className = 'card';
    box.style.marginTop = '-1rem';
    document.getElementById('ocr-card').after(box);
  }
  box.innerHTML = `
    <h3 style="margin-top:0">OCR a lu « ${q || '(vide)'} » — candidats probables</h3>
    <p class="small">Clique sur la bonne personne, ou <a href="#" id="show-full">afficher toute la base</a>.</p>
    <div class="match-list">
      ${candidates.map((m, i) => {
        const reasons = [];
        if (m.scorePrenom  >= 0.85) reasons.push(`<span class="badge jour">Prénom ${Math.round(m.scorePrenom * 100)}%</span>`);
        if (m.scoreNom     >= 0.85) reasons.push(`<span class="badge jour">Nom ${Math.round(m.scoreNom * 100)}%</span>`);
        if (m.scorePrenomX >= 0.85) reasons.push(`<span class="badge total">Prénom↔Nom ${Math.round(m.scorePrenomX * 100)}%</span>`);
        if (m.scoreNomX    >= 0.85) reasons.push(`<span class="badge total">Nom↔Prénom ${Math.round(m.scoreNomX * 100)}%</span>`);
        if (m.scoreFull    >= 0.60 && m.scoreFull < 0.85) reasons.push(`<span class="badge total">Complet ${Math.round(m.scoreFull * 100)}%</span>`);
        const reasonStr = reasons.length ? reasons.join(' ') : `<span class="badge neutral">~${Math.round(m.score * 100)}%</span>`;
        const contrats = m.contrats || [];
        const contratLabel = contrats.length ? `${contrats.length} contrat${contrats.length > 1 ? 's' : ''} actif${contrats.length > 1 ? 's' : ''}` : 'aucun contrat actif';
        return `
          <button class="match-btn" data-idx="${i}">
            <span>
              <strong>${m.prenom} ${m.nom}</strong>
              ${m.matricule ? `<span class="badge neutral">#${m.matricule}</span>` : ''}
              <span class="small" style="display:block;margin-top:0.15rem">${reasonStr} · ${contratLabel}</span>
            </span>
          </button>
        `;
      }).join('')}
    </div>
  `;
  box.querySelectorAll('.match-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      applySelectedInterimaire(candidates[idx], { date });
      box.remove();
      const statusEl = document.getElementById('ocr-status');
      statusEl.textContent = `✓ ${candidates[idx].prenom} ${candidates[idx].nom} sélectionné.`;
      statusEl.style.color = 'var(--c-success)';
    });
  });
  box.querySelector('#show-full').addEventListener('click', async (e) => {
    e.preventDefault();
    await ensureInterimairesLoaded();
    box.remove();
    showFullBaseChooser({ q, date });
  });
}

// Applique un intermédiaire choisi (depuis match auto ou depuis chooser)
function applySelectedInterimaire(person, { date }) {
  document.getElementById('f-nom').value = person.nom;
  document.getElementById('f-prenom').value = person.prenom;
  if (person.matricule || person.matricule_notion) {
    document.getElementById('f-matricule').value = person.matricule || person.matricule_notion;
  }
  delete document.getElementById('f-nom').dataset.doute;
  delete document.getElementById('f-prenom').dataset.doute;
  currentMatchedIntermId = person.id;
  currentPersonContrats = person.contrats || [];

  const contrats = person.contrats || [];
  const todayIso = date || new Date().toISOString().slice(0, 10);
  // Un contrat « actif » sur la date demandée
  const isActiveOn = (c, iso) => {
    const debut = c.date_debut || c.debut;
    const fin   = c.date_fin   || c.fin;
    return (!debut || debut <= iso) && (!fin || fin >= iso);
  };
  const actifs = contrats.filter(c => isActiveOn(c, todayIso));

  const fillContrat = (c) => {
    const num = c.numero || c.numero_contrat;
    document.getElementById('f-contrat').value = c.avenant > 0 ? `${num},${c.avenant}` : num;
    if (c.client) {
      document.getElementById('f-client').value = c.client;
      delete document.getElementById('f-client').dataset.doute;
    }
  };

  if (actifs.length === 1) {
    fillContrat(actifs[0]);
  } else if (actifs.length > 1) {
    // on pré-remplit avec le premier actif pour ne pas laisser vide
    fillContrat(actifs[0]);
    showContratChooser(person, actifs);
  } else if (contrats.length > 0) {
    // Aucun contrat actif à la date : fallback sur le plus récent (déjà trié
    // par le worker). On remplit la raison sociale mais on marque en doute,
    // et on ne pré-remplit PAS f-contrat car le contrat est expiré.
    const recent = contrats[0];
    if (recent.client) {
      document.getElementById('f-client').value = recent.client;
      document.getElementById('f-client').dataset.doute = '1';
    }
  }
  // Auto-remplit la colonne Contrat de CHAQUE jour selon sa date (gère le
  // cas où la semaine chevauche deux contrats — jours lundi sur contrat A,
  // jeudi sur contrat B).
  applyPerDayContrats();
  updateMatchIndicator();
}

// Chooser sur la BASE COMPLÈTE (obligatoire si pas de match fiable)
function showFullBaseChooser({ q, date }) {
  let box = document.getElementById('match-chooser');
  if (!box) {
    box = document.createElement('div');
    box.id = 'match-chooser';
    box.className = 'card';
    box.style.marginTop = '-1rem';
    document.getElementById('ocr-card').after(box);
  }
  const todayIso = (date || new Date().toISOString().slice(0, 10));
  box.innerHTML = `
    <h3 style="margin-top:0">Sélectionne l'intérimaire dans la base</h3>
    <p class="small">L'OCR a lu « ${q || '(vide)'} » mais ce nom n'existe pas en base. Tape pour filtrer :</p>
    <input type="text" id="chooser-filter" placeholder="Rechercher par nom, prénom, matricule…" style="margin-bottom:0.75rem">
    <div id="chooser-results" class="match-list" style="max-height:420px;overflow-y:auto"></div>
  `;
  const render = (list) => {
    const results = box.querySelector('#chooser-results');
    if (!list.length) {
      results.innerHTML = '<p class="small">Aucun résultat.</p>'; return;
    }
    results.innerHTML = list.slice(0, 50).map((i) => {
      const activeContract = (i.contrats || []).find(c => !c.fin || c.fin >= todayIso);
      const label = activeContract
        ? `${activeContract.client || '—'} (${activeContract.debut} → ${activeContract.fin || 'en cours'})`
        : `${(i.contrats || []).length} contrat${(i.contrats || []).length > 1 ? 's' : ''} en base`;
      return `
        <button class="match-btn" data-id="${i.id}">
          <span>
            <strong>${i.prenom} ${i.nom}</strong>
            ${i.matricule_notion ? `<span class="badge neutral">#${i.matricule_notion}</span>` : ''}
            <span class="small" style="display:block">${label}</span>
          </span>
        </button>
      `;
    }).join('');
    results.querySelectorAll('.match-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const person = cachedInterimaires.find(i => i.id === id);
        if (!person) return;
        applySelectedInterimaire(person, { date });
        box.remove();
        const statusEl = document.getElementById('ocr-status');
        statusEl.textContent = `✓ ${person.prenom} ${person.nom} sélectionné manuellement depuis la base.`;
        statusEl.style.color = 'var(--c-success)';
      });
    });
  };
  render(cachedInterimaires);
  box.querySelector('#chooser-filter').addEventListener('input', (e) => {
    const qn = e.target.value.toLowerCase().trim();
    if (!qn) { render(cachedInterimaires); return; }
    const filtered = cachedInterimaires.filter(i =>
      `${i.prenom} ${i.nom}`.toLowerCase().includes(qn) ||
      (i.matricule_notion || '').toLowerCase().includes(qn) ||
      (i.contrats || []).some(c => (c.client || '').toLowerCase().includes(qn))
    );
    render(filtered);
  });
  box.querySelector('#chooser-filter').focus();
}

function showMatchChooser(matches, { q, date }) {
  let box = document.getElementById('match-chooser');
  if (!box) {
    box = document.createElement('div');
    box.id = 'match-chooser';
    box.className = 'card';
    box.style.marginTop = '-1rem';
    document.getElementById('ocr-card').after(box);
  }
  box.innerHTML = `
    <h3 style="margin-top:0">Plusieurs correspondances possibles pour « ${q} »</h3>
    <p class="small">Clique sur la bonne personne, ou <a href="#" id="show-full">afficher toute la base</a>.</p>
    <div class="match-list">
      ${matches.map((m, i) => `
        <button class="match-btn" data-idx="${i}">
          <strong>${m.prenom} ${m.nom}</strong>
          <span class="badge">${Math.round(m.score * 100)}%</span>
          ${m.contrats.length ? `<span class="small">${m.contrats.length} contrat(s) actif(s)</span>` : '<span class="small">aucun contrat actif</span>'}
        </button>
      `).join('')}
    </div>
  `;
  box.querySelectorAll('.match-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      applySelectedInterimaire(matches[idx], { date });
      box.remove();
    });
  });
  box.querySelector('#show-full').addEventListener('click', async (e) => {
    e.preventDefault();
    await ensureInterimairesLoaded();
    box.remove();
    showFullBaseChooser({ q, date });
  });
}

function showContratChooser(person, contrats) {
  let box = document.getElementById('contrat-chooser');
  if (!box) {
    box = document.createElement('div');
    box.id = 'contrat-chooser';
    box.className = 'card';
    box.style.marginTop = '-1rem';
    document.getElementById('ocr-card').after(box);
  }
  box.innerHTML = `
    <h3 style="margin-top:0">${person.prenom} ${person.nom} a plusieurs contrats actifs</h3>
    <p class="small">Sélectionne le contrat correspondant à ce bordereau :</p>
    <div class="match-list">
      ${contrats.map((c, i) => `
        <button class="match-btn" data-idx="${i}">
          <strong>Contrat ${c.numero_contrat}${c.avenant > 0 ? ',' + c.avenant : ''}</strong>
          <span class="small">${c.client || '(pas de client)'} — ${c.date_debut || '?'} → ${c.date_fin || 'en cours'}</span>
        </button>
      `).join('')}
    </div>
  `;
  box.querySelectorAll('.match-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const c = contrats[idx];
      document.getElementById('f-contrat').value = c.avenant > 0 ? `${c.numero_contrat},${c.avenant}` : c.numero_contrat;
      if (c.client) document.getElementById('f-client').value = c.client;
      box.remove();
    });
  });
}

// --- Archiver (D1 + R2) ---
document.getElementById('btn-archive').addEventListener('click', async () => {
  if (!getAuthToken()) { setArchiveStatus('Renseigne ton email + token équipe (section 0).', true); return; }
  // Validation stricte : l'intérimaire DOIT exister en base
  await ensureInterimairesLoaded();
  const nom = document.getElementById('f-nom').value;
  const prenom = document.getElementById('f-prenom').value;
  const match = findExactMatch(nom, prenom);
  if (!match) {
    setArchiveStatus(`⚠ Impossible d'archiver : "${prenom} ${nom}" n'existe pas dans la base Notion. Sélectionne un intérimaire dans la base avec "Changer d'intérimaire".`, true);
    return;
  }
  const r = generate();
  if (!r) return;
  const { csv, bordereau } = r;
  if (!bordereau.semaineDu) {
    const lundi = document.getElementById('f-lundi').value;
    if (!lundi) { setArchiveStatus('Lundi de la semaine obligatoire pour archiver.', true); return; }
    bordereau.semaineDu = lundi;
    const d = new Date(lundi); d.setDate(d.getDate() + 6);
    bordereau.semaineAu = d.toISOString().slice(0, 10);
  }
  setArchiveStatus(editingBordereauId ? 'Mise à jour en cours...' : 'Archivage en cours...');
  try {
    if (editingBordereauId) {
      // Mode édition : PATCH sans toucher au PDF original
      const res = await updateBordereau(editingBordereauId, {
        bordereau, dayHoursFn: dayHours, csvPld: csv,
      });
      setArchiveStatus(`✓ Bordereau #${res.id} mis à jour (champs : ${(res.changed || []).join(', ')}).`);
      editingBordereauId = null;
      updateEditBanner();
      refreshHistory();
    } else {
      // Mode création : POST classique
      const res = await saveBordereau({
        bordereau, dayHoursFn: dayHours, csvPld: csv,
        source: lastUploadedFile ? 'ocr' : 'manual',
        pdfFile: lastUploadedFile,
        fileHash: lastUploadedHash,
      });
      setArchiveStatus(`Archivé (id=${res.id}, statut: pending_review)${res.pdfKey ? ` — PDF: ${res.pdfKey}` : ''}`);
      refreshHistory();
    }
  } catch (err) {
    // Le worker renvoie 409 avec message « duplicate » si le hash existe déjà
    if (/\b409\b/.test(err.message) && /duplicate/i.test(err.message)) {
      setArchiveStatus(`⚠ Déjà archivé : ${err.message}`, true);
    } else {
      setArchiveStatus(`Erreur : ${err.message}`, true);
    }
  }
});

// Indicateur de match + bouton changer
document.getElementById('f-nom').addEventListener('input', updateMatchIndicator);
document.getElementById('f-prenom').addEventListener('input', updateMatchIndicator);

document.getElementById('btn-change-person').addEventListener('click', async () => {
  await ensureInterimairesLoaded();
  const date = document.getElementById('f-lundi').value || null;
  const q = `${document.getElementById('f-prenom').value} ${document.getElementById('f-nom').value}`.trim();
  showFullBaseChooser({ q, date });
});

// Au démarrage : précharge la base si token déjà présent
if (getAuthToken()) {
  ensureInterimairesLoaded().then(() => updateMatchIndicator());
}

function setArchiveStatus(msg, isError = false) {
  const el = document.getElementById('archive-status');
  el.textContent = msg;
  el.style.color = isError ? '#d70015' : '#0f6b3c';
}

// --- Edition d'un bordereau existant : charge les données dans le formulaire
//     et passe l'app en mode « édition » (Archiver devient PATCH).
async function startEditFlow(id) {
  try {
    const b = await getBordereau(id);
    if (!b) { alert('Bordereau introuvable.'); return; }
    // Bascule en mode single et réinitialise le form
    const singleTab = document.querySelector('.mode-tab[data-mode="single"]');
    if (singleTab) singleTab.click();
    clearForm();
    // Charge les champs
    document.getElementById('f-nom').value      = b.nom || '';
    document.getElementById('f-prenom').value   = b.prenom || '';
    document.getElementById('f-matricule').value = b.matricule || '';
    document.getElementById('f-client').value   = b.client || '';
    document.getElementById('f-contrat').value  = b.contrat_defaut || '';
    if (b.semaine_du) {
      lundiInput.value = b.semaine_du;
      syncDates();
    }
    // Charge les jours
    const jours = JSON.parse(b.jours_json || '[]');
    const JOURS = ['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'];
    for (const j of jours) {
      const idxJour = j.jour ? JOURS.indexOf(String(j.jour).toLowerCase()) : -1;
      let idx = idxJour;
      if (idx < 0 && j.date && b.semaine_du) {
        // Retrouve l'index par écart de jours
        const d1 = new Date(b.semaine_du + 'T00:00:00Z');
        const d2 = new Date(j.date + 'T00:00:00Z');
        idx = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
      }
      if (idx < 0 || idx > 6) continue;
      const tr = tbody.querySelectorAll('tr')[idx];
      if (!tr) continue;
      const setF = (f, v) => {
        const el = tr.querySelector(`[data-field=${f}]`);
        if (el && v !== undefined && v !== null) el.value = v;
      };
      setF('matinDebut', j.matin?.debut);
      setF('matinFin',   j.matin?.fin);
      setF('amDebut',    j.apresMidi?.debut);
      setF('amFin',      j.apresMidi?.fin);
      if (j.contrat) setF('contrat', j.contrat);
      const ferie = tr.querySelector('[data-field=ferie]');
      if (ferie) ferie.checked = !!j.ferie;
    }
    recompute();
    // Met l'état en édition et met à jour l'UI
    editingBordereauId = id;
    updateEditBanner();
    // Affiche le PDF à droite si disponible
    if (b.pdf_r2_key) {
      try {
        const { url, mediaType } = await fetchPdfBlobUrl(b.pdf_r2_key);
        const aside = document.getElementById('side-preview');
        const bodyEl = document.getElementById('side-preview-body');
        document.getElementById('side-preview-name').textContent = `#${b.id} · ${b.prenom} ${b.nom}`;
        bodyEl.innerHTML = mediaType.includes('pdf')
          ? `<iframe src="${url}" class="side-preview-iframe"></iframe>`
          : `<img src="${url}" class="side-preview-img" alt="">`;
        aside.style.display = 'flex';
        document.body.classList.add('with-side-preview');
      } catch (e) {
        console.warn('PDF preview indisponible', e);
      }
    }
    document.getElementById('ocr-card').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    alert('Erreur chargement : ' + err.message);
  }
}

function cancelEditFlow() {
  editingBordereauId = null;
  updateEditBanner();
  clearForm();
}

function updateEditBanner() {
  let bar = document.getElementById('edit-banner');
  const archiveBtn = document.getElementById('btn-archive');
  if (editingBordereauId) {
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'edit-banner';
      bar.className = 'edit-banner';
      document.getElementById('ocr-card').before(bar);
    }
    bar.innerHTML = `
      <strong>✏️ Mode édition — Bordereau #${editingBordereauId}</strong>
      <p class="small">Tu modifies un bordereau déjà en base. Les changements mettront à jour l'existant (pas un nouveau).</p>
      <button class="secondary" id="btn-cancel-edit">Annuler la modification</button>
    `;
    bar.style.display = 'block';
    document.getElementById('btn-cancel-edit').onclick = cancelEditFlow;
    if (archiveBtn) archiveBtn.textContent = 'Enregistrer les modifications';
  } else {
    if (bar) bar.style.display = 'none';
    if (archiveBtn) archiveBtn.textContent = 'Archiver (D1 + R2)';
  }
}

// --- Preview d'un bordereau archivé (depuis l'historique) ---
async function openHistoryPreview(id) {
  const b = (window.__historyBordereaux || []).find(x => x.id === id);
  if (!b) return;
  if (!b.pdf_r2_key) { alert('Pas de PDF archivé pour ce bordereau.'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card preview-card">
      <div class="preview-header">
        <div>
          <h3 style="margin:0">${b.prenom} ${b.nom}</h3>
          <p class="small" style="margin:0.25rem 0 0">${b.client || '?'} · semaine ${b.semaine_du} · HT ${(b.total_ht ?? 0).toFixed(2)}</p>
        </div>
        <button class="modal-btn secondary" data-close>Fermer</button>
      </div>
      <div class="preview-body"><p class="small">Chargement du PDF…</p></div>
    </div>
  `;
  const cleanup = (blobUrl) => {
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    document.body.removeChild(overlay);
    document.removeEventListener('keydown', onKey);
  };
  let currentBlob = null;
  const onKey = (e) => { if (e.key === 'Escape') cleanup(currentBlob); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.close !== undefined) cleanup(currentBlob);
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  try {
    const { url, mediaType } = await fetchPdfBlobUrl(b.pdf_r2_key);
    currentBlob = url;
    const body = overlay.querySelector('.preview-body');
    body.innerHTML = mediaType.includes('pdf')
      ? `<iframe src="${url}" class="preview-iframe"></iframe>`
      : `<img src="${url}" class="preview-img" alt="">`;
  } catch (err) {
    overlay.querySelector('.preview-body').innerHTML = `<p class="small" style="color:var(--c-danger)">Erreur chargement : ${err.message}</p>`;
  }
}

// --- Suppression avec double confirmation (1 = aperçu, 2 = tape SUPPRIMER) ---
async function startDeleteFlow(id) {
  const b = (window.__historyBordereaux || []).find(x => x.id === id);
  if (!b) return;
  // Étape 1 : modal avec aperçu PDF et infos, bouton Continuer
  const overlay1 = document.createElement('div');
  overlay1.className = 'modal-overlay';
  overlay1.innerHTML = `
    <div class="modal-card preview-card">
      <div class="preview-header">
        <div>
          <h3 style="margin:0;color:var(--c-danger)">🗑 Supprimer ce bordereau ?</h3>
          <p class="small" style="margin:0.25rem 0 0">
            <strong>${b.prenom} ${b.nom}</strong> · ${b.client || '?'} · semaine ${b.semaine_du}
            · HT ${(b.total_ht ?? 0).toFixed(2)} · HN ${(b.total_hn ?? 0).toFixed(2)}
            · statut ${b.status || '?'}
          </p>
        </div>
        <button class="modal-btn secondary" data-close>Annuler</button>
      </div>
      <div class="preview-body"><p class="small">Chargement du PDF…</p></div>
      <div class="preview-footer">
        <p class="small" style="color:var(--c-danger)">
          ⚠ Action <strong>irréversible</strong> : supprime la ligne D1 + le PDF original en R2.
          ${b.exported ? '<br>⚠ Ce bordereau a DÉJÀ été exporté dans PLD (batch #' + (b.export_batch_id || '?') + ').' : ''}
        </p>
        <div class="modal-actions">
          <button class="modal-btn" data-next>Continuer vers la suppression</button>
        </div>
      </div>
    </div>
  `;
  let blobUrl1 = null;
  const cleanup1 = () => {
    if (blobUrl1) URL.revokeObjectURL(blobUrl1);
    document.body.removeChild(overlay1);
  };
  overlay1.addEventListener('click', async (e) => {
    if (e.target === overlay1 || e.target.dataset.close !== undefined) { cleanup1(); return; }
    if (e.target.dataset.next !== undefined) {
      cleanup1();
      showFinalDeleteConfirmation(b);
    }
  });
  document.body.appendChild(overlay1);
  if (b.pdf_r2_key) {
    try {
      const { url, mediaType } = await fetchPdfBlobUrl(b.pdf_r2_key);
      blobUrl1 = url;
      const body = overlay1.querySelector('.preview-body');
      body.innerHTML = mediaType.includes('pdf')
        ? `<iframe src="${url}" class="preview-iframe"></iframe>`
        : `<img src="${url}" class="preview-img" alt="">`;
    } catch (err) {
      overlay1.querySelector('.preview-body').innerHTML = `<p class="small" style="color:var(--c-danger)">Erreur PDF : ${err.message}</p>`;
    }
  } else {
    overlay1.querySelector('.preview-body').innerHTML = `<p class="small">Pas de PDF archivé pour ce bordereau.</p>`;
  }
}

function showFinalDeleteConfirmation(b) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>⚠ Confirmation finale</h3>
      <p class="small">Tu vas supprimer <strong>définitivement</strong> :</p>
      <div class="modal-info">
        <div><strong>${b.prenom} ${b.nom}</strong></div>
        <div class="small">${b.client || '?'} · semaine du ${b.semaine_du}</div>
        <div class="small">Bordereau #${b.id}</div>
      </div>
      <p class="small">Pour confirmer, tape <strong>SUPPRIMER</strong> en majuscules :</p>
      <input type="text" id="del-confirm-input" placeholder="SUPPRIMER" autocomplete="off" style="width:100%;margin-top:0.5rem">
      <div class="modal-actions" style="margin-top:1rem">
        <button class="modal-btn secondary" data-close>Annuler</button>
        <button class="modal-btn" id="btn-del-confirm" disabled style="background:var(--c-danger)">Supprimer définitivement</button>
      </div>
      <p id="del-status" class="small" style="margin-top:0.5rem"></p>
    </div>
  `;
  const cleanup = () => { if (overlay.parentNode) document.body.removeChild(overlay); };
  const input = overlay.querySelector('#del-confirm-input');
  const btn   = overlay.querySelector('#btn-del-confirm');
  const status = overlay.querySelector('#del-status');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.close !== undefined) cleanup();
  });
  input.addEventListener('input', () => {
    btn.disabled = input.value.trim() !== 'SUPPRIMER';
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    status.textContent = 'Suppression en cours…';
    status.style.color = 'var(--c-text-muted)';
    try {
      await deleteBordereau(b.id);
      status.textContent = '✓ Supprimé';
      status.style.color = 'var(--c-success)';
      setTimeout(() => { cleanup(); refreshHistory(); }, 700);
    } catch (err) {
      status.textContent = `Erreur : ${err.message}`;
      status.style.color = 'var(--c-danger)';
      btn.disabled = false;
    }
  });
  document.body.appendChild(overlay);
  input.focus();
}

// --- Historique ---
async function refreshHistory() {
  const body = document.getElementById('history-body');
  body.innerHTML = '<tr><td colspan="9" class="small">Chargement...</td></tr>';
  try {
    const { bordereaux } = await listBordereaux();
    if (!bordereaux?.length) {
      body.innerHTML = '<tr><td colspan="9" class="small">Aucun bordereau archivé.</td></tr>';
      return;
    }
    const statusBadge = (s) => {
      if (s === 'validated') return '<span class="badge jour">✓ validé</span>';
      if (s === 'rejected')  return '<span class="badge total">✗ rejeté</span>';
      return '<span class="badge neutral">à réviser</span>';
    };
    const exportBadge = (b) => b.exported
      ? `<span class="badge jour" title="Exporté le ${b.exported_at || '?'}${b.export_batch_id ? ' (batch #' + b.export_batch_id + ')' : ''}">✓ exporté</span>`
      : '<span class="badge neutral">non exporté</span>';
    body.innerHTML = bordereaux.map(b => `
      <tr data-id="${b.id}" class="${b.exported ? 'already-exported' : ''}">
        <td><input type="checkbox" class="hist-check" data-check="${b.id}"></td>
        <td>${(b.created_at || '').slice(0, 16)}</td>
        <td>${b.nom || ''}</td>
        <td>${b.prenom || ''}</td>
        <td>${b.client || ''}</td>
        <td>${b.semaine_du || ''}</td>
        <td class="num">${(b.total_ht ?? 0).toFixed(2)}</td>
        <td class="num">${(b.total_hn ?? 0).toFixed(2)}</td>
        <td>${statusBadge(b.status)} ${exportBadge(b)}</td>
        <td>${b.validated_by || ''}</td>
        <td>
          ${b.pdf_r2_key ? `<button class="btn-small" data-view-hist="${b.id}" title="Voir le PDF">👁</button>` : ''}
          <button class="btn-small" data-edit="${b.id}" title="Modifier">✏️</button>
          <button class="btn-small danger" data-delete="${b.id}" title="Supprimer définitivement">🗑</button>
        </td>
      </tr>
    `).join('');
    // Wire les checkboxes pour update du compteur
    body.querySelectorAll('.hist-check').forEach(cb => {
      cb.addEventListener('change', updateSelectionUi);
    });
    updateSelectionUi();
    // Stocke les bordereaux pour retrouver leur pdf_r2_key au clic
    window.__historyBordereaux = bordereaux;
    // Wire les boutons
    body.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => startDeleteFlow(parseInt(btn.dataset.delete, 10)));
    });
    body.querySelectorAll('[data-view-hist]').forEach(btn => {
      btn.addEventListener('click', () => openHistoryPreview(parseInt(btn.dataset.viewHist, 10)));
    });
    body.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => startEditFlow(parseInt(btn.dataset.edit, 10)));
    });
  } catch (err) {
    body.innerHTML = `<tr><td colspan="9" style="color:#d70015">${err.message}</td></tr>`;
  }
}
document.getElementById('btn-refresh-list').addEventListener('click', refreshHistory);

// ===== Sélection multi-lignes + export groupé =====
function getSelectedHistoryIds() {
  return Array.from(document.querySelectorAll('.hist-check:checked'))
    .map(cb => parseInt(cb.dataset.check, 10));
}
function updateSelectionUi() {
  const ids = getSelectedHistoryIds();
  const btn = document.getElementById('btn-export-selection');
  const cnt = document.getElementById('selection-count');
  if (btn) btn.disabled = ids.length === 0;
  if (cnt) cnt.textContent = ids.length ? `${ids.length} bordereau(x) sélectionné(s)` : '';
}
document.getElementById('hist-select-all').addEventListener('change', (e) => {
  document.querySelectorAll('.hist-check').forEach(cb => { cb.checked = e.target.checked; });
  updateSelectionUi();
});

document.getElementById('btn-export-selection').addEventListener('click', async () => {
  const ids = getSelectedHistoryIds();
  if (ids.length === 0) return;
  const btn = document.getElementById('btn-export-selection');
  btn.disabled = true;
  const originalLbl = btn.textContent;
  btn.textContent = '⏳ Génération...';
  try {
    // 1. Récupère les détails complets (jours_json) pour tous les IDs
    const { bordereaux } = await batchFetchBordereaux(ids);
    if (!bordereaux || bordereaux.length === 0) throw new Error('Aucun bordereau trouvé');

    // Avertir si certains sont déjà exportés
    const alreadyExported = bordereaux.filter(b => b.exported);
    if (alreadyExported.length > 0) {
      const ok = confirm(
        `⚠ ${alreadyExported.length} bordereau(x) sur ${bordereaux.length} ont DÉJÀ été exporté(s) ` +
        `dans un batch précédent. Les ré-exporter créera un nouveau batch et marquera ces bordereaux ` +
        `comme ré-exportés (verrou souple). Continuer ?`
      );
      if (!ok) { btn.disabled = false; btn.textContent = originalLbl; return; }
    }

    // 2. Génère le CSV concaténé avec les codes PLD configurés (section 8)
    const codes = getPldCodes();
    const csvOptions = {
      codeTotal: codes.total, codeNormales: codes.jour, codeNuit: codes.nuit,
      codeSupT1: codes.t1, codeSupT2: codes.t2,
      codeFerie: codes.ferie, codeDimanche: codes.dimanche,
    };
    const allRows = [];
    for (const b of bordereaux) {
      const jours = JSON.parse(b.jours_json || '[]');
      // Reconstruit un "bordereau" exploitable par bordereauToRows
      const bord = {
        nom: b.nom, prenom: b.prenom, matricule: b.matricule,
        contratDefaut: b.contrat_defaut, reference: null,
        jours,
      };
      // dayHoursFn spécialisé : utilise les totaux déjà stockés dans jours_json
      // (totalHt/totalHn calculés au moment du save) pour pas recalculer.
      const dayHoursFromStored = (j) => ({
        jour: Number(j.totalHt) || 0,
        nuit: Number(j.totalHn) || 0,
        totalMin: ((Number(j.totalHt) || 0) + (Number(j.totalHn) || 0)) * 60,
      });
      const rows = bordereauToRows(bord, dayHoursFromStored, csvOptions);
      allRows.push(...rows);
    }
    const csvText = toCsv(allRows);

    // 3. Upload en R2 + crée batch + marque exported
    btn.textContent = '⏳ Archivage...';
    const { batchId, count, periodStart, periodEnd } = await batchExport({
      ids: bordereaux.map(b => b.id),
      csv: csvText,
    });

    // 4. Téléchargement local
    const fname = `pld-export-batch-${batchId}-${periodStart || 'nd'}_${periodEnd || 'nd'}.csv`;
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    a.click();
    URL.revokeObjectURL(a.href);

    alert(`✓ Export CSV #${batchId} : ${count} bordereau(x) exporté(s) (${periodStart || '?'} → ${periodEnd || '?'}). Téléchargement lancé.`);
    refreshHistory();
  } catch (err) {
    alert('Erreur export : ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = originalLbl;
  }
});

// --- RGPD ---
document.getElementById('btn-rgpd-export').addEventListener('click', async () => {
  const nom = document.getElementById('rgpd-nom').value.trim();
  const prenom = document.getElementById('rgpd-prenom').value.trim();
  const out = document.getElementById('rgpd-status');
  if (!nom || !prenom) { out.textContent = 'Nom et prénom obligatoires.'; out.style.color = '#d70015'; return; }
  try {
    const data = await rgpdExport(nom, prenom);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `rgpd-export-${nom}-${prenom}.json`;
    a.click();
    out.textContent = `Export RGPD généré (${data.bordereaux?.length || 0} enregistrements).`;
    out.style.color = '#0f6b3c';
  } catch (err) {
    out.textContent = `Erreur : ${err.message}`; out.style.color = '#d70015';
  }
});
document.getElementById('btn-rgpd-forget').addEventListener('click', async () => {
  const nom = document.getElementById('rgpd-nom').value.trim();
  const prenom = document.getElementById('rgpd-prenom').value.trim();
  const out = document.getElementById('rgpd-status');
  if (!nom || !prenom) { out.textContent = 'Nom et prénom obligatoires.'; out.style.color = '#d70015'; return; }
  if (!confirm(`Supprimer les données de ${prenom} ${nom} (> 5 ans uniquement, les plus récentes sont conservées pour obligation légale) ?`)) return;
  try {
    const data = await rgpdForget(nom, prenom);
    out.textContent = `${data.deleted} supprimés, ${data.retained} conservés (obligation légale < 5 ans).`;
    out.style.color = '#0f6b3c';
    refreshHistory();
  } catch (err) {
    out.textContent = `Erreur : ${err.message}`; out.style.color = '#d70015';
  }
});

// ===== Onglets Single / Batch =====
const singleZone = document.getElementById('dropzone');
const batchZone  = document.getElementById('batch-zone');
const batchInput = document.getElementById('f-batch-file');
document.querySelectorAll('.mode-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.mode;
    singleZone.style.display = mode === 'single' ? '' : 'none';
    batchZone.style.display  = mode === 'batch' ? '' : 'none';
  });
});

// ===== Drop / click batch =====
batchZone.addEventListener('click', () => batchInput.click());
batchZone.addEventListener('dragover', e => { e.preventDefault(); batchZone.classList.add('drag'); });
batchZone.addEventListener('dragleave', () => batchZone.classList.remove('drag'));
batchZone.addEventListener('drop', async e => {
  e.preventDefault();
  batchZone.classList.remove('drag');
  await handleBatchDrop(Array.from(e.dataTransfer.files));
});
batchInput.addEventListener('change', async e => {
  await handleBatchDrop(Array.from(e.target.files));
  e.target.value = '';
});

// Stocke les fichiers du dernier batch pour pouvoir les prévisualiser
// après traitement (clic sur une ligne du tableau de progression).
let lastBatchFiles = [];
let lastBatchResults = [];

// Modal de preview : affiche l'image ou le PDF d'un fichier du batch,
// avec action « Traiter manuellement » qui bascule en mode single.
function showBatchPreview(idx) {
  const file = lastBatchFiles[idx];
  const r = lastBatchResults[idx];
  if (!file) return;
  const objectUrl = URL.createObjectURL(file);
  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card preview-card">
      <div class="preview-header">
        <div>
          <h3 style="margin:0">${file.name}</h3>
          <p class="small" style="margin:0.25rem 0 0">
            ${statusText(r?.status)}${r?.reason ? ' — ' + r.reason : ''}
          </p>
        </div>
        <button class="modal-btn secondary" data-close>Fermer</button>
      </div>
      <div class="preview-body">
        ${isPdf
          ? `<iframe src="${objectUrl}" class="preview-iframe"></iframe>`
          : `<img src="${objectUrl}" class="preview-img" alt="${file.name}">`}
      </div>
      <div class="preview-footer">
        <p class="small">${file.type || 'type inconnu'} · ${Math.round(file.size / 1024)} KB</p>
        <div class="modal-actions">
          ${r?.status === 'no_match' || r?.status === 'not_a_bordereau' || r?.status === 'error'
            ? `<button class="modal-btn" data-manual>Traiter manuellement (mode single)</button>`
            : ''}
        </div>
      </div>
    </div>
  `;
  const cleanup = () => {
    URL.revokeObjectURL(objectUrl);
    document.body.removeChild(overlay);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') cleanup(); };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.dataset.close !== undefined) cleanup();
    if (e.target.dataset.manual !== undefined) {
      cleanup();
      switchToSingleAndLoad(file);
    }
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

function statusText(status) {
  switch (status) {
    case 'ok':              return '🟢 archivé';
    case 'duplicate':       return '🟡 doublon (déjà en base)';
    case 'no_match':        return '🔵 pas en base';
    case 'not_a_bordereau': return '🔵 non-bordereau';
    case 'error':           return '🔴 erreur';
    case 'processing':      return '⏳ en cours';
    default:                return 'en attente';
  }
}

// Bascule en mode single et charge le fichier (utile pour les écartés).
function switchToSingleAndLoad(file) {
  document.querySelector('.mode-tab[data-mode="single"]').click();
  handleFile(file);
  document.getElementById('ocr-card').scrollIntoView({ behavior: 'smooth' });
}

async function handleBatchDrop(initialFiles) {
  if (!initialFiles || initialFiles.length === 0) return;
  if (!getAuthToken()) {
    renderBatchError('Renseigne ton token équipe (section 0) avant de lancer un batch.');
    return;
  }
  // 1. Si un .zip : on l'extrait. Sinon on prend la sélection telle quelle.
  let files = [];
  const skippedFromZip = [];
  for (const f of initialFiles) {
    if (/\.zip$/i.test(f.name)) {
      renderBatchProgress(`Extraction du ZIP ${f.name}…`);
      const { files: extracted, skipped } = await extractZip(f);
      files = files.concat(extracted);
      skippedFromZip.push(...skipped);
    } else {
      files.push(f);
    }
  }
  if (files.length === 0 && skippedFromZip.length === 0) {
    renderBatchError('Aucun fichier exploitable trouvé.');
    return;
  }

  // 2. Détection HEIC → modal de confirmation
  const heicFiles = files.filter(f => /\.(heic|heif)$/i.test(f.name) || /heic|heif/i.test(f.type || ''));
  if (heicFiles.length > 0) {
    const convert = await confirm(`🍎 ${heicFiles.length} fichier${heicFiles.length > 1 ? 's' : ''} HEIC détecté${heicFiles.length > 1 ? 's' : ''} (format iPhone).\n\nClaude Vision n'accepte pas HEIC directement. Convertir en JPEG ?\n\nOK = convertir, Annuler = ignorer ces fichiers`);
    if (convert) {
      renderBatchProgress(`Conversion HEIC en cours…`);
      const converted = [];
      for (const f of heicFiles) {
        try {
          const jpg = await convertHeicFile(f);
          converted.push({ old: f, new: jpg });
        } catch (err) {
          skippedFromZip.push({ file: f, reason: 'heic_conversion_failed', details: err.message });
        }
      }
      files = files.map(f => {
        const match = converted.find(c => c.old === f);
        return match ? match.new : f;
      }).filter(f => !skippedFromZip.some(s => s.file === f));
    } else {
      // Non-conversion : on ignore les HEIC
      files = files.filter(f => !heicFiles.includes(f));
      for (const f of heicFiles) {
        skippedFromZip.push({ file: f, reason: 'heic_not_converted', details: 'HEIC ignoré à la demande de l\'utilisateur' });
      }
    }
  }

  // 3. Lance le batch
  const moisReference = document.getElementById('f-mois-ref').value || null;
  lastBatchFiles = files;
  lastBatchResults = files.map(() => ({ status: 'pending' }));
  renderBatchStart(files);
  const { results, report } = await processBatch(files, {
    moisReference,
    concurrency: 2,
    onFileUpdate: (i, r) => {
      lastBatchResults[i] = r;
      renderFileRow(i, r);
    },
  });
  lastBatchResults = results;
  renderBatchReport(results, report, skippedFromZip);
  refreshHistory();
}

function renderBatchError(msg) {
  const box = document.getElementById('batch-report');
  box.style.display = 'block';
  box.innerHTML = `<p class="small" style="color:var(--c-danger)">${msg}</p>`;
}

function renderBatchProgress(msg) {
  const prog = document.getElementById('batch-progress');
  prog.style.display = 'block';
  prog.innerHTML = `<p class="small">${msg}</p>`;
}

function renderBatchStart(files) {
  const prog = document.getElementById('batch-progress');
  const report = document.getElementById('batch-report');
  report.style.display = 'none';
  prog.style.display = 'block';
  prog.innerHTML = `
    <h3 style="margin:0.5rem 0">Traitement en cours (${files.length} fichier${files.length > 1 ? 's' : ''})</h3>
    <p class="small" style="margin:0.25rem 0 0.5rem">Clique sur une ligne pour voir le bordereau.</p>
    <div class="batch-table-wrap">
      <table class="batch-table">
        <thead><tr><th>#</th><th>Fichier</th><th>Statut</th><th>Détail</th><th></th></tr></thead>
        <tbody id="batch-tbody">
          ${files.map((f, i) => `
            <tr data-idx="${i}" class="batch-row">
              <td class="num">${i + 1}</td>
              <td class="fname">${f.name}</td>
              <td class="status"><span class="badge neutral">en attente</span></td>
              <td class="detail small"></td>
              <td class="action"><button class="btn-view" data-view="${i}">👁 Voir</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  // Câblage click sur ligne entière ou bouton 👁
  const tbody = document.getElementById('batch-tbody');
  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) {
      e.stopPropagation();
      showBatchPreview(parseInt(btn.dataset.view, 10));
      return;
    }
    const tr = e.target.closest('tr.batch-row');
    if (tr) showBatchPreview(parseInt(tr.dataset.idx, 10));
  });
}

function renderFileRow(i, r) {
  const tr = document.querySelector(`#batch-tbody tr[data-idx="${i}"]`);
  if (!tr) return;
  const statusCell = tr.querySelector('.status');
  const detailCell = tr.querySelector('.detail');
  const pill = (cls, label) => `<span class="badge ${cls}">${label}</span>`;
  if (r.status === 'pending')        statusCell.innerHTML = pill('neutral', 'en attente');
  else if (r.status === 'processing') statusCell.innerHTML = pill('neutral', `⏳ ${r.step || 'traitement'}`);
  else if (r.status === 'ok')         statusCell.innerHTML = pill('jour',    '🟢 archivé');
  else if (r.status === 'duplicate')  statusCell.innerHTML = pill('neutral', '🟡 doublon');
  else if (r.status === 'no_match')   statusCell.innerHTML = pill('total',   '🔵 pas en base');
  else if (r.status === 'not_a_bordereau') statusCell.innerHTML = pill('total', '🔵 non-bordereau');
  else if (r.status === 'error')      statusCell.innerHTML = pill('danger',  '🔴 erreur');
  detailCell.textContent = r.reason || (r.person ? `${r.person.prenom} ${r.person.nom} #${r.bordereauId || '?'}` : '');
}

function renderBatchReport(results, report, skipped) {
  const prog = document.getElementById('batch-progress');
  const box  = document.getElementById('batch-report');
  box.style.display = 'block';
  const rejCount = skipped.length;
  box.innerHTML = `
    <h3 style="margin:1rem 0 0.5rem">Rapport d'ingestion</h3>
    <div class="batch-counters">
      <div class="counter ok"><span class="n">${report.ok}</span><span class="lbl">🟢 Nouveaux archivés</span></div>
      <div class="counter dup"><span class="n">${report.duplicates}</span><span class="lbl">🟡 Doublons (déjà en base)</span></div>
      <div class="counter skip"><span class="n">${report.noMatch + report.notBordereau + rejCount}</span><span class="lbl">🔵 Écartés (non-bordereau / hors base)</span></div>
      <div class="counter err"><span class="n">${report.errors}</span><span class="lbl">🔴 Erreurs</span></div>
    </div>
    <p class="small" style="margin-top:0.75rem">Tous les bordereaux archivés sont en <strong>statut « à réviser »</strong>. L'export CSV PLD (étape 4) ne les prendra qu'après validation manuelle.</p>
  `;
}

buildRows();

// Pré-remplir le mois de référence au mois courant
(() => {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const input = document.getElementById('f-mois-ref');
  if (input && !input.value) input.value = ym;
})();

// ===== Wire up de la section 8 (Paramètres export PLD) =====
(() => {
  const stored = getPldCodes();
  const fields = [
    ['p-code-total',    'total',    DEFAULT_PLD_CODES.total],
    ['p-code-jour',     'jour',     DEFAULT_PLD_CODES.jour],
    ['p-code-nuit',     'nuit',     DEFAULT_PLD_CODES.nuit],
    ['p-code-t1',       't1',       DEFAULT_PLD_CODES.t1],
    ['p-code-t2',       't2',       DEFAULT_PLD_CODES.t2],
    ['p-code-ferie',    'ferie',    DEFAULT_PLD_CODES.ferie],
    ['p-code-dimanche', 'dimanche', DEFAULT_PLD_CODES.dimanche],
    ['p-code-cp',       'cp',       DEFAULT_PLD_CODES.cp],
    ['p-code-rtt',      'rtt',      DEFAULT_PLD_CODES.rtt],
    ['p-code-am',       'am',       DEFAULT_PLD_CODES.am],
  ];
  const statusEl = document.getElementById('pld-settings-status');
  const showSaved = () => {
    if (!statusEl) return;
    statusEl.textContent = '✓ Paramètres sauvegardés dans ce navigateur';
    statusEl.style.color = 'var(--c-success)';
    clearTimeout(statusEl._t);
    statusEl._t = setTimeout(() => statusEl.textContent = '', 1800);
  };
  for (const [id, key, def] of fields) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.value = stored[key] || def;
    el.addEventListener('input', () => {
      const codes = getPldCodes();
      codes[key] = (el.value.trim() || def).toUpperCase();
      setPldCodes(codes);
      showSaved();
    });
  }
})();

// Pré-remplissage démo : semaine du 20/04/2026, Benoit COMAS Hermès
lundiInput.value = '2026-04-20';
syncDates();
document.getElementById('f-nom').value = 'COMAS';
document.getElementById('f-prenom').value = 'Benoît';
const rows = tbody.querySelectorAll('tr');
// Lundi
rows[0].querySelector('[data-field=matinDebut]').value = '09:00';
rows[0].querySelector('[data-field=matinFin]').value = '13:27';
rows[0].querySelector('[data-field=amDebut]').value = '14:04';
rows[0].querySelector('[data-field=amFin]').value = '20:09';
// Mardi
rows[1].querySelector('[data-field=matinDebut]').value = '10:00';
rows[1].querySelector('[data-field=matinFin]').value = '12:32';
rows[1].querySelector('[data-field=amDebut]').value = '15:26';
rows[1].querySelector('[data-field=amFin]').value = '23:51';
recompute();
