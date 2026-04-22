// Split d'une plage horaire entre heures jour (06h-21h) et heures nuit (21h-06h).
// Entrée : "HH:MM" ou "HHhMM" ou {h, m}. Sortie : { jour, nuit } en centièmes d'heure.

const DAY_START = 6 * 60;   // 06h00 en minutes
const DAY_END = 21 * 60;    // 21h00 en minutes

function parseTime(t) {
  if (typeof t === 'object' && t !== null) return t.h * 60 + t.m;
  const s = String(t).trim().replace('h', ':').replace('H', ':');
  const [h, m] = s.split(':').map(n => parseInt(n, 10) || 0);
  return h * 60 + m;
}

function toCent(minutes) {
  return Math.round((minutes / 60) * 100) / 100;
}

// Retourne les minutes qui tombent dans la plage jour [06h00, 21h00[ sur un intervalle.
// L'intervalle peut traverser minuit : si end < start, on considère que end est le lendemain.
function minutesInDayRange(start, end) {
  if (end <= start) end += 24 * 60;
  let total = 0;
  // On découpe l'intervalle [start, end] en tranches par 24h et on compte la partie [06h, 21h[
  for (let base = Math.floor(start / (24 * 60)) * 24 * 60; base < end; base += 24 * 60) {
    const dayFrom = base + DAY_START;
    const dayTo = base + DAY_END;
    const lo = Math.max(start, dayFrom);
    const hi = Math.min(end, dayTo);
    if (hi > lo) total += hi - lo;
  }
  return total;
}

// Calcule les heures jour/nuit pour une plage "HH:MM" → "HH:MM".
// Si end < start, l'intervalle traverse minuit.
export function splitDayNight(start, end) {
  const s = parseTime(start);
  const e = parseTime(end);
  const total = e <= s ? (e + 24 * 60 - s) : (e - s);
  const dayMin = minutesInDayRange(s, e);
  const nightMin = total - dayMin;
  return { jour: toCent(dayMin), nuit: toCent(nightMin), totalMin: total };
}

// Agrège matin + après-midi pour un jour (pause non payée entre les deux).
export function dayHours({ matin, apresMidi }) {
  const out = { jour: 0, nuit: 0, totalMin: 0 };
  for (const plage of [matin, apresMidi]) {
    if (!plage || !plage.debut || !plage.fin) continue;
    const { jour, nuit, totalMin } = splitDayNight(plage.debut, plage.fin);
    out.jour += jour;
    out.nuit += nuit;
    out.totalMin += totalMin;
  }
  out.jour = Math.round(out.jour * 100) / 100;
  out.nuit = Math.round(out.nuit * 100) / 100;
  return out;
}
