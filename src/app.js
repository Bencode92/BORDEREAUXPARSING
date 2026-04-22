import { dayHours } from './time-split.js';
import { bordereauToRows, toCsv } from './csv-pld.js';

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
