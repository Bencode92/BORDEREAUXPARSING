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

// === Calendrier des jours fériés français ===
// Calcul de Pâques (algorithme grégorien de Gauss/Oudin)
function easterDate(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const L = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * L) / 451);
  const month = Math.floor((h + L - 7 * m + 114) / 31);
  const day = ((h + L - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}
function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}
function isoDay(d) { return d.toISOString().slice(0, 10); }

// Jours fériés légaux en France métropolitaine (fixes + mobiles liés à Pâques).
const _holidayCache = new Map();
export function frenchHolidays(year) {
  if (_holidayCache.has(year)) return _holidayCache.get(year);
  const easter = easterDate(year);
  const set = new Set([
    isoDay(new Date(Date.UTC(year, 0, 1))),    // 1er janvier (Jour de l'An)
    isoDay(addDays(easter, 1)),                  // Lundi de Pâques
    isoDay(new Date(Date.UTC(year, 4, 1))),    // 1er mai (Fête du Travail)
    isoDay(new Date(Date.UTC(year, 4, 8))),    // 8 mai (Victoire 1945)
    isoDay(addDays(easter, 39)),                 // Ascension
    isoDay(addDays(easter, 50)),                 // Lundi de Pentecôte
    isoDay(new Date(Date.UTC(year, 6, 14))),   // 14 juillet (Fête Nationale)
    isoDay(new Date(Date.UTC(year, 7, 15))),   // 15 août (Assomption)
    isoDay(new Date(Date.UTC(year, 10, 1))),   // 1er novembre (Toussaint)
    isoDay(new Date(Date.UTC(year, 10, 11))),  // 11 novembre (Armistice)
    isoDay(new Date(Date.UTC(year, 11, 25))),  // 25 décembre (Noël)
  ]);
  _holidayCache.set(year, set);
  return set;
}
export function isFrenchHoliday(iso) {
  if (!iso) return false;
  const year = parseInt(iso.slice(0, 4), 10);
  return frenchHolidays(year).has(iso);
}

// === Génération des lignes CSV PLD avec règles Cameleon ===
// Règles hebdomadaires :
//   - 0 → 35h = HN (heures normales, code HJ dans la Correspondance Cameleon)
//   - 35h → 43h = HS T1 (max 8h, 125%)
//   - 43h+ = HS T2 (illimité, 150%)
//   - Dimanche : toutes les heures du dimanche → HD (200%)
//   - Férié (calendrier auto ou case cochée) : toutes → HF
//   - Heures de nuit (21h-06h) : ajoute un complément HN
//   - Toujours : 1 ligne HT par jour avec le total travaillé (informative)
export function bordereauToRows(bordereau, dayHoursFn, options = {}) {
  const {
    codeTotal    = 'HT',   // Hrs travaillées (total informatif)
    codeNormales = 'HJ',   // Heures normales = « Heure de jour » dans la config Cameleon
    codeNuit     = 'HN',   // Complément heures de nuit
    codeSupT1    = 'HS1',  // Heures sup T1 (125%)
    codeSupT2    = 'HS2',  // Heures sup T2 (150%)
    codeFerie    = 'HF',   // Heures fériés
    codeDimanche = 'HD',   // Heures dimanche
  } = options;

  const rows = [];
  const defaults = parseContratField(bordereau.contratDefaut);

  // Tri par date pour cumul hebdo correct (les sup commencent après 35h cumulées)
  const jours = (bordereau.jours || [])
    .filter(j => j.date)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));

  let cumulRegular = 0;  // cumul des heures "régulières" (ni dimanche ni férié) dans la semaine

  for (const jour of jours) {
    const h = dayHoursFn(jour);
    const total = (h.jour || 0) + (h.nuit || 0);
    if (total <= 0) continue;

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

    const d = new Date(jour.date + 'T00:00:00Z');
    const isDim   = d.getUTCDay() === 0;
    const isFerie = !!jour.ferie || isFrenchHoliday(jour.date);

    // Ligne totale (toujours, informative pour Tempo)
    rows.push({ ...base, code: codeTotal, libelle: 'Heures travaillées', quantite: total.toFixed(2) });

    if (isDim) {
      rows.push({ ...base, code: codeDimanche, libelle: 'Heures dimanche', quantite: total.toFixed(2) });
    } else if (isFerie) {
      rows.push({ ...base, code: codeFerie, libelle: 'Heures fériés', quantite: total.toFixed(2) });
    } else {
      // Split normales / T1 / T2 selon cumul hebdo des heures régulières
      let remain = total;
      const qNormales = Math.min(remain, Math.max(35 - cumulRegular, 0));
      remain -= qNormales; cumulRegular += qNormales;
      if (qNormales > 0) {
        rows.push({ ...base, code: codeNormales, libelle: 'Heures normales', quantite: qNormales.toFixed(2) });
      }
      const qT1 = Math.min(remain, Math.max(43 - cumulRegular, 0));
      remain -= qT1; cumulRegular += qT1;
      if (qT1 > 0) {
        rows.push({ ...base, code: codeSupT1, libelle: 'Heures sup T1 (125%)', quantite: qT1.toFixed(2) });
      }
      if (remain > 0) {
        cumulRegular += remain;
        rows.push({ ...base, code: codeSupT2, libelle: 'Heures sup T2 (150%)', quantite: remain.toFixed(2) });
      }
    }

    // Complément heures de nuit (21h-06h) — toujours en plus, quel que soit le jour
    if (h.nuit > 0) {
      rows.push({ ...base, code: codeNuit, libelle: 'Complément heures de nuit', quantite: h.nuit.toFixed(2) });
    }
  }
  return rows;
}
