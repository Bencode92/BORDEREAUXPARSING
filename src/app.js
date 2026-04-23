import { dayHours } from './time-split.js';
import { bordereauToRows, toCsv } from './csv-pld.js';
import { ocrBordereau } from './ocr.js';
import {
  getAuthToken, setAuthToken, getUserEmail, setUserEmail,
  saveBordereau, listBordereaux, rgpdExport, rgpdForget,
  importIntermediaires, matchIntermediaire, listIntermediaires,
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
notionInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!getAuthToken()) {
    notionStatus.textContent = 'Renseigne ton token équipe avant d\'importer (section 0).';
    notionStatus.style.color = '#d70015';
    return;
  }
  notionStatus.textContent = `Lecture de ${file.name}...`;
  notionStatus.style.color = '#0071e3';
  try {
    const text = await file.text();
    const { rows, errors } = parseNotionCsv(text);
    if (errors.length) console.warn('Erreurs parsing CSV :', errors);
    if (!rows.length) {
      notionStatus.textContent = `Aucune ligne exploitable. ${errors.length} erreur(s). Voir console.`;
      notionStatus.style.color = '#d70015';
      return;
    }
    notionStatus.textContent = `${rows.length} ligne(s) parsée(s). Import en cours...`;
    const res = await importIntermediaires(rows);
    const s = res.stats;
    notionStatus.textContent = `✓ Import OK : ${s.intermediaires.inserted} nouveau(x) + ${s.intermediaires.updated} mis à jour · ${s.contrats.inserted + s.contrats.updated} contrat(s).${errors.length ? ' ' + errors.length + ' ligne(s) ignorée(s).' : ''}`;
    notionStatus.style.color = '#0f6b3c';
  } catch (err) {
    console.error(err);
    notionStatus.textContent = `Erreur : ${err.message}`;
    notionStatus.style.color = '#d70015';
  }
  e.target.value = '';
});

document.getElementById('btn-list-interm').addEventListener('click', async () => {
  if (!getAuthToken()) { notionStatus.textContent = 'Token requis.'; notionStatus.style.color = '#d70015'; return; }
  try {
    const { intermediaires } = await listIntermediaires(500);
    notionStatus.textContent = `${intermediaires.length} intérimaire(s) en base. Détails en console.`;
    console.table(intermediaires);
    notionStatus.style.color = '#0071e3';
  } catch (err) {
    notionStatus.textContent = `Erreur : ${err.message}`;
    notionStatus.style.color = '#d70015';
  }
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
    setStatus(`OCR terminé : ${joursRemplis} jour(s) travaillé(s), ${total} valeur(s) en rouge à vérifier. Recherche du contrat…`);

    // Auto-correction nom/prénom/contrat depuis la base intérimaires
    if (getAuthToken()) {
      try {
        const q = `${data.prenom || ''} ${data.nom || ''}`.trim();
        const date = data.semaineDu || document.getElementById('f-lundi').value || null;
        if (q) {
          const { matches } = await matchIntermediaire({ q, date, limit: 5 });
          applyInterimaireMatch(matches, { q, date });
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

function applyInterimaireMatch(matches, { q, date }) {
  const statusEl = document.getElementById('ocr-status');
  if (!matches || matches.length === 0) {
    statusEl.textContent += ' Aucun intérimaire trouvé en base.';
    return;
  }
  const best = matches[0];
  const SCORE_AUTO = 0.80;   // ≥ 80% similaire : on corrige automatiquement
  const SCORE_MIN  = 0.50;   // 50-80% : on propose une liste

  if (best.score >= SCORE_AUTO) {
    // Correction auto
    const nomInput = document.getElementById('f-nom');
    const prenomInput = document.getElementById('f-prenom');
    const matriculeInput = document.getElementById('f-matricule');
    const contratInput = document.getElementById('f-contrat');
    const wasWrong = nomInput.value !== best.nom || prenomInput.value !== best.prenom;
    nomInput.value = best.nom;
    prenomInput.value = best.prenom;
    if (best.matricule) matriculeInput.value = best.matricule;
    delete nomInput.dataset.doute;
    delete prenomInput.dataset.doute;

    const contrats = best.contrats || [];
    if (contrats.length === 1) {
      const c = contrats[0];
      contratInput.value = c.avenant > 0 ? `${c.numero_contrat},${c.avenant}` : c.numero_contrat;
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} trouvé (match ${Math.round(best.score * 100)}%) — Contrat ${c.numero_contrat}${c.avenant > 0 ? ' av.' + c.avenant : ''} chez ${c.client}.`;
      statusEl.style.color = '#0f6b3c';
    } else if (contrats.length > 1) {
      showContratChooser(best, contrats);
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} trouvé. ${contrats.length} contrats actifs → choisir ci-dessous.`;
    } else {
      statusEl.textContent = `✓ ${best.prenom} ${best.nom} trouvé mais aucun contrat actif ${date ? `le ${date}` : ''}.`;
      statusEl.style.color = '#b85c00';
    }
    if (wasWrong) console.info('Nom corrigé :', q, '→', `${best.prenom} ${best.nom}`);
  } else if (best.score >= SCORE_MIN) {
    showMatchChooser(matches.filter(m => m.score >= SCORE_MIN), { q });
  } else {
    statusEl.textContent += ` Aucun match fiable (meilleur score ${Math.round(best.score * 100)}%). Saisir manuellement.`;
    statusEl.style.color = '#b85c00';
  }
}

function showMatchChooser(matches, { q }) {
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
    <p class="small">Clique sur la bonne personne :</p>
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
      const m = matches[idx];
      document.getElementById('f-nom').value = m.nom;
      document.getElementById('f-prenom').value = m.prenom;
      if (m.matricule) document.getElementById('f-matricule').value = m.matricule;
      delete document.getElementById('f-nom').dataset.doute;
      delete document.getElementById('f-prenom').dataset.doute;
      if (m.contrats.length === 1) {
        const c = m.contrats[0];
        document.getElementById('f-contrat').value = c.avenant > 0 ? `${c.numero_contrat},${c.avenant}` : c.numero_contrat;
      } else if (m.contrats.length > 1) {
        showContratChooser(m, m.contrats);
      }
      box.remove();
    });
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
      box.remove();
    });
  });
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
