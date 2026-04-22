import { dayHours } from './time-split.js';
import { bordereauToRows, toCsv } from './csv-pld.js';
import { ocrBordereau } from './ocr.js';
import {
  getAuthToken, setAuthToken, getUserEmail, setUserEmail,
  saveBordereau, listBordereaux, rgpdExport, rgpdForget,
} from './archive.js';

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

async function handleFile(file) {
  lastUploadedFile = file;
  setStatus(`OCR en cours sur ${file.name}...`);
  try {
    const data = await ocrBordereau(file);
    applyOcrResult(data);
    const nbDoutesJours = (data.jours || []).reduce((n, j) => n + (j.doutes?.length || 0), 0);
    const nbDoutesGlob = (data.doutesGlobaux || []).length;
    const total = nbDoutesJours + nbDoutesGlob;
    const joursRemplis = (data.jours || []).filter(j => j.matinDebut || j.matinFin || j.amDebut || j.amFin).length;
    setStatus(`OCR terminé : ${joursRemplis} jour(s) travaillé(s), ${total} valeur(s) en rouge à vérifier.`);
  } catch (err) {
    console.error(err);
    setStatus(`Erreur OCR : ${err.message}`, true);
  }
}

// --- Archiver (D1 + R2) ---
document.getElementById('btn-archive').addEventListener('click', async () => {
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
  if (!getAuthToken()) { setArchiveStatus('Renseigne ton email + token équipe (section 0).', true); return; }

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
