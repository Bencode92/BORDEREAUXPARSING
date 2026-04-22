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

// Helper : construit les lignes à partir d'un bordereau complet.
// bordereau = { nom, prenom, matricule?, contratDefaut?, reference?, jours: [{date, matin, apresMidi, contrat?, ferie?}] }
// Chaque jour génère 1 ou 2 lignes (HT et/ou HN).
export function bordereauToRows(bordereau, dayHoursFn) {
  const rows = [];
  for (const jour of bordereau.jours || []) {
    if (!jour.date) continue;
    const h = dayHoursFn(jour);
    const contrat = jour.contrat || bordereau.contratDefaut;
    const base = {
      nom: bordereau.nom,
      prenom: bordereau.prenom,
      matricule: bordereau.matricule,
      date: jour.date,
      contrat,
      avenant: jour.avenant ?? 0,
      reference: bordereau.reference,
    };
    if (h.jour > 0) {
      rows.push({ ...base, code: 'HT', libelle: 'Heures travaillées', quantite: h.jour.toFixed(2) });
    }
    if (h.nuit > 0) {
      rows.push({ ...base, code: 'HN', libelle: 'Heures de nuit', quantite: h.nuit.toFixed(2) });
    }
  }
  return rows;
}
