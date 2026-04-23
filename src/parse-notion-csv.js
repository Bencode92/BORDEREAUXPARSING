// Parser du CSV Notion pour la base intérimaires de Cameleons.
// Gère les cas pénibles :
//  - "PRENOM NOM" concaténé dans une seule colonne
//  - N° contrat avec avenant sous forme "46544,1" (virgule interne, mal échappée par Notion)
//  - Dates françaises "2 février 2026" (pas ISO malgré le nom de colonne)
//  - Lignes vides, BOM UTF-8

const MOIS_FR = {
  'janvier': 1, 'février': 2, 'fevrier': 2, 'mars': 3, 'avril': 4, 'mai': 5,
  'juin': 6, 'juillet': 7, 'août': 8, 'aout': 8, 'septembre': 9,
  'octobre': 10, 'novembre': 11, 'décembre': 12, 'decembre': 12,
};

export function parseFrenchDate(s) {
  if (!s) return null;
  const str = String(s).trim().toLowerCase();
  if (!str) return null;
  // Déjà ISO (YYYY-MM-DD) ?
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // Format "2 février 2026"
  const m = str.match(/^(\d{1,2})\s+([a-zéèêûçù]+)\s+(\d{4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mois = MOIS_FR[m[2]];
    if (!mois) return null;
    const year = parseInt(m[3], 10);
    return `${year}-${String(mois).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // JJ/MM/YYYY
  const m2 = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m2) return `${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return null;
}

// Normalisation pour fuzzy search : retire accents, lowercase, compact espaces.
export function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Split "PRENOM NOM" ou "PRENOM COMPOSÉ NOM" → { prenom, nom }.
// Heuristique : le dernier mot est le nom (convention française habituelle dans les exports RH).
export function splitFullName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { prenom: '', nom: '' };
  if (parts.length === 1) return { prenom: '', nom: parts[0] };
  const nom = parts[parts.length - 1];
  const prenom = parts.slice(0, -1).join(' ');
  return { prenom, nom };
}

// Parse un numéro contrat sous forme "46544", "46544,1" ou "47403,2".
export function parseNumContrat(s) {
  if (!s) return { numero: null, avenant: 0 };
  const str = String(s).trim();
  const m = str.match(/^(\d+)(?:[,.](\d+))?$/);
  if (!m) return { numero: str, avenant: 0 };
  return { numero: m[1], avenant: m[2] ? parseInt(m[2], 10) : 0 };
}

// CSV parser RFC-4180-ish, tolérant au "row entirement quoté" que produit Notion
// quand une colonne contient une virgule interne.
export function parseCsvLines(text) {
  const rows = [];
  let cur = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const s = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');

  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { cur.push(field); field = ''; i++; continue; }
    if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows.filter(r => r.some(f => f && f.length));
}

// Remet d'équerre une ligne où Notion a quoté toute la ligne (un seul champ
// contenant les vraies valeurs séparées par des virgules, avec des virgules
// internes dans "46544,1" déjà dé-échappées par le parser).
// Ex : ["BENOIT COMAS,46544,1,3128,CHRISTIAN DIOR COUTURE,2 février 2026,24 juillet 2026"]
// → on veut : ["BENOIT COMAS", "46544,1", "3128", "CHRISTIAN DIOR COUTURE", "2 février 2026", "24 juillet 2026"]
function recoverCollapsedRow(singleField, expectedCols) {
  const parts = singleField.split(',').map(s => s.trim());
  // Si on retrouve le bon nombre de colonnes, parfait.
  if (parts.length === expectedCols) return parts;
  // Sinon, on suppose que la 2e colonne (N Ctr) contient une virgule : on la fusionne.
  if (parts.length === expectedCols + 1) {
    return [
      parts[0],
      `${parts[1]},${parts[2]}`,   // numéro contrat avec avenant
      ...parts.slice(3),
    ];
  }
  return parts;
}

// Parse tout le CSV Notion → { rows: [{prenom, nom, matricule, numero, avenant, client, debut, fin}], errors: [] }
export function parseNotionCsv(text) {
  const rawRows = parseCsvLines(text);
  if (rawRows.length === 0) return { rows: [], errors: ['CSV vide'] };

  // Détection des colonnes à partir de l'en-tête
  const header = rawRows[0].map(h => normalizeName(h));
  const idxIntermediaire = header.findIndex(h => h.includes('interimaire') || h.includes('intérimaire'));
  const idxContrat       = header.findIndex(h => h.includes('n ctr') || h === 'n contrat' || h === 'numero contrat');
  const idxMatricule     = header.findIndex(h => h.includes('n interim') || h === 'matricule');
  const idxClient        = header.findIndex(h => h === 'client' || h.includes('societe'));
  const idxDebut         = header.findIndex(h => h.includes('debut'));
  const idxFin           = header.findIndex(h => h.includes('fin'));

  if (idxIntermediaire === -1 || idxContrat === -1) {
    return { rows: [], errors: ['Colonnes obligatoires manquantes (Intérimaires, N Ctr)'] };
  }

  const expectedCols = rawRows[0].length;
  const out = [];
  const errors = [];

  for (let lineNum = 1; lineNum < rawRows.length; lineNum++) {
    let r = rawRows[lineNum];
    if (r.length === 1 && r[0]) r = recoverCollapsedRow(r[0], expectedCols);
    if (r.length < expectedCols - 1) {
      errors.push(`Ligne ${lineNum + 1} : trop peu de colonnes (${r.length})`);
      continue;
    }
    const { prenom, nom } = splitFullName(r[idxIntermediaire]);
    const { numero, avenant } = parseNumContrat(r[idxContrat]);
    const matricule = idxMatricule !== -1 ? (r[idxMatricule] || '').trim() : '';
    const client = idxClient !== -1 ? (r[idxClient] || '').trim() : '';
    const debut = idxDebut !== -1 ? parseFrenchDate(r[idxDebut]) : null;
    const fin = idxFin !== -1 ? parseFrenchDate(r[idxFin]) : null;

    if (!nom || !prenom) {
      errors.push(`Ligne ${lineNum + 1} : impossible d'extraire nom/prénom de "${r[idxIntermediaire]}"`);
      continue;
    }
    out.push({ prenom, nom, matricule, numero, avenant, client, debut, fin });
  }

  return { rows: out, errors };
}
