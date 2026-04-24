// Génération du CSV au format PLD Tempo 7.
// Spec :
//   - séparateur ';', délimiteur '"', fin de ligne CRLF
//   - pas d'en-tête
//   - date AAAAMMJJ
//   - durée en centièmes d'heure
// Colonnes :
//   Version ; Matricule ; Nom ; Prénom ; Date ; Contrat ; Avenant ;
//   Code ; CodeAbsence ; Libellé ; Quantité ; Prix ; IFMICP ; FdM ; Référence

function q(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function fmtDate(d) {
  if (!d) return '';
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const j = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${j}`;
  }
  // Accepte "YYYY-MM-DD" ou "DD/MM/YYYY"
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, '');
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) {
    const [jj, mm, aaaa] = s.split('/');
    return `${aaaa}${mm}${jj}`;
  }
  if (/^\d{8}$/.test(s)) return s;
  return s;
}

// Entrée : une ligne logique (un jour × un code)
// { nom, prenom, date, contrat, avenant?, code ('HT'|'HN'|...), libelle?, quantite,
//   matricule?, codeAbsence?, prix?, ifmicp?, fdm?, reference? }
export function toCsvLine(r) {
  const cols = [
    q('V1'),
    q(r.matricule),
    q(r.nom),
    q(r.prenom),
    q(fmtDate(r.date)),
    q(r.contrat),
    q(r.avenant ?? 0),
    q(r.code),
    q(r.codeAbsence),
    q(r.libelle),
    q(r.quantite),
    q(r.prix),
    q(r.ifmicp),
    q(r.fdm),
    q(r.reference),
  ];
  return cols.join(';');
}

export function toCsv(rows) {
  return rows.map(toCsvLine).join('\r\n') + '\r\n';
}

// Parse "46544,1" en { numero: "46544", avenant: 1 } ; "100285" → { numero: "100285", avenant: 0 }
function parseContratField(raw) {
  if (!raw) return { numero: '', avenant: 0 };
  const s = String(raw).trim();
  const m = s.match(/^(.+?)[,\s]+(\d+)$/);
  if (m) return { numero: m[1].trim(), avenant: parseInt(m[2], 10) || 0 };
  return { numero: s, avenant: 0 };
}

// Helper : construit les lignes à partir d'un bordereau complet.
// bordereau = { nom, prenom, matricule?, contratDefaut?, reference?, jours: [{date, matin, apresMidi, contrat?, ferie?}] }
// options = { codeJour, codeNuit } — codes PLD configurés dans l'app (section 8).
// Chaque jour génère 1 ou 2 lignes (jour et/ou nuit).
export function bordereauToRows(bordereau, dayHoursFn, options = {}) {
  const { codeJour = 'HJ', codeNuit = 'HN' } = options;
  const rows = [];
  const defaults = parseContratField(bordereau.contratDefaut);
  for (const jour of bordereau.jours || []) {
    if (!jour.date) continue;
    const h = dayHoursFn(jour);
    // Priorité : contrat du jour > contrat par défaut du bordereau
    const parsed = jour.contrat ? parseContratField(jour.contrat) : defaults;
    const base = {
      nom: bordereau.nom,
      prenom: bordereau.prenom,
      matricule: bordereau.matricule,
      date: jour.date,
      contrat: parsed.numero,
      avenant: parsed.avenant,
      reference: bordereau.reference,
    };
    if (h.jour > 0) {
      rows.push({ ...base, code: codeJour, libelle: 'Heures de jour', quantite: h.jour.toFixed(2) });
    }
    if (h.nuit > 0) {
      rows.push({ ...base, code: codeNuit, libelle: 'Heures de nuit', quantite: h.nuit.toFixed(2) });
    }
  }
  return rows;
}
