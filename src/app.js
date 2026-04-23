import { dayHours } from './time-split.js';
import { bordereauToRows, toCsv } from './csv-pld.js';
import { ocrBordereau } from './ocr.js';
import {
  getAuthToken, setAuthToken, getUserEmail, setUserEmail,
  saveBordereau, listBordereaux, rgpdExport, rgpdForget,
  importIntermediaires, matchIntermediaire, listIntermediaires,
  listSnapshots, snapshotDownloadUrl,
} from './archive.js';
import { parseNotionCsv } from './parse-notion-csv.js';

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
    tr.querySelector('[data-field=date]').value = addDate(lundi, i);
  });
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

  const ul = document.getElementById('alerts');
  if (alerts.length === 0) {
    ul.innerHTML = '<li class="small">Aucune</li>';
  } else {
    ul.innerHTML = alerts.map(a => `<li>${a}</li>`).join('');
  }
}

function generate() {
  const bordereau = collectBordereau();
  if (!bordereau.nom || !bordereau.prenom) {
    alert('Nom et Prénom obligatoires.');
    return null;
  }
  const rows = bordereauToRows(bordereau, dayHours);
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
    const ferie = tr.querySelector('[data-field=ferie]');
    if (ferie) ferie.checked = false;
  });
  delete document.getElementById('f-nom').dataset.doute;
  delete document.getElementById('f-prenom').dataset.doute;
  recompute();
}

function applyOcrResult(data) {
  clearForm();
  const doutesGlobaux = new Set(data.doutesGlobaux || []);
  const markDoubt = (id, field) => {
    const el = document.getElementById(id);
    if (el && doutesGlobaux.has(field)) el.dataset.doute = '1';
    else if (el) delete el.dataset.doute;
  };
  if (data.nom) document.getElementById('f-nom').value = data.nom;
  if (data.prenom) document.getElementById('f-prenom').value = data.prenom;
  markDoubt('f-nom', 'nom');
  markDoubt('f-prenom', 'prenom');
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

function firstMondayOfMonth(moisReference) {
  // moisReference : "YYYY-MM"
  if (!moisReference) return null;
  const [y, m] = moisReference.split('-').map(Number);
  if (!y || !m) return null;
  const d = new Date(Date.UTC(y, m - 1, 1));
  const dow = d.getUTCDay(); // 0=dim, 1=lun...
  const offset = dow === 0 ? 1 : (dow === 1 ? 0 : 8 - dow);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function isDateInMonth(iso, moisReference) {
  if (!iso || !moisReference) return false;
  return iso.slice(0, 7) === moisReference;
}

async function handleFile(file) {
  lastUploadedFile = file;
  const moisReference = document.getElementById('f-mois-ref').value || null;
  setStatus(`OCR en cours sur ${file.name}...`);
  try {
    const data = await ocrBordereau(file, { moisReference });

    // Fallback : si la date lue est nulle ou hors du mois de référence,
    // on force le premier lundi du mois sélectionné.
    if (moisReference) {
      if (!data.semaineDu || !isDateInMonth(data.semaineDu, moisReference)) {
        const fallback = firstMondayOfMonth(moisReference);
        if (fallback) {
          data.semaineDu = fallback;
          data.doutesGlobaux = Array.from(new Set([...(data.doutesGlobaux || []), 'semaineDu']));
        }
      }
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
    if (contrats.length === 1) {
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} (match ${Math.round(best.score * 100)}%) — Contrat ${contrats[0].numero_contrat}${contrats[0].avenant > 0 ? ' av.' + contrats[0].avenant : ''} chez ${contrats[0].client}.`;
      statusEl.style.color = 'var(--c-success)';
    } else if (contrats.length > 1) {
      showContratChooser(best, contrats);
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} trouvé. ${contrats.length} contrats actifs → choisir ci-dessous.`;
      statusEl.style.color = 'var(--c-success)';
    } else {
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} trouvé mais aucun contrat actif ${date ? `le ${date}` : ''}.`;
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

  const contrats = person.contrats || [];
  if (contrats.length === 1) {
    const c = contrats[0];
    document.getElementById('f-contrat').value = c.avenant > 0 ? `${c.numero || c.numero_contrat},${c.avenant}` : (c.numero || c.numero_contrat);
    if (c.client) document.getElementById('f-client').value = c.client;
  } else if (contrats.length > 1) {
    // Privilégier le contrat actif à la date demandée
    const todayIso = date || new Date().toISOString().slice(0, 10);
    const active = contrats.find(c => (!c.date_fin && !c.fin) || (c.date_fin || c.fin) >= todayIso);
    if (active && active.client) document.getElementById('f-client').value = active.client;
    showContratChooser(person, contrats);
  }
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
  setArchiveStatus('Archivage en cours...');
  try {
    const res = await saveBordereau({
      bordereau, dayHoursFn: dayHours, csvPld: csv,
      source: lastUploadedFile ? 'ocr' : 'manual',
      pdfFile: lastUploadedFile,
    });
    setArchiveStatus(`Archivé (id=${res.id})${res.pdfKey ? ` — PDF: ${res.pdfKey}` : ''}`);
    refreshHistory();
  } catch (err) {
    setArchiveStatus(`Erreur archivage : ${err.message}`, true);
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
    body.innerHTML = bordereaux.map(b => `
      <tr>
        <td>${(b.created_at || '').slice(0, 16)}</td>
        <td>${b.nom || ''}</td>
        <td>${b.prenom || ''}</td>
        <td>${b.client || ''}</td>
        <td>${b.semaine_du || ''}</td>
        <td class="num">${(b.total_ht ?? 0).toFixed(2)}</td>
        <td class="num">${(b.total_hn ?? 0).toFixed(2)}</td>
        <td>${b.source || ''}</td>
        <td>${b.validated_by || ''}</td>
      </tr>
    `).join('');
  } catch (err) {
    body.innerHTML = `<tr><td colspan="9" style="color:#d70015">${err.message}</td></tr>`;
  }
}
document.getElementById('btn-refresh-list').addEventListener('click', refreshHistory);

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

buildRows();

// Pré-remplir le mois de référence au mois courant
(() => {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const input = document.getElementById('f-mois-ref');
  if (input && !input.value) input.value = ym;
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
