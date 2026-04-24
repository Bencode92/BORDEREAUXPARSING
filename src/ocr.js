// OCR via Claude Vision API, à travers le Worker Cloudflare studyforge-proxy.
// La clé Anthropic est stockée en secret côté Worker (env.ANTHROPIC_API_KEY) :
// le navigateur ne la voit jamais.

const API_URL = 'https://studyforge-proxy.benoit-comas.workers.dev/';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT_BASE = `Tu es un extracteur de données pour des bordereaux français d'intérimaires (agence Cameleons RH).

DEUX FORMATS DE BORDEREAUX À DISTINGUER :

FORMAT A — « BORDEREAU D'HEURES » (hebdomadaire avec heures HH:MM) :
- Titre visible : « BORDEREAU D'HEURES »
- Table avec 7 lignes : Lundi, Mardi, Mercredi, Jeudi, Vendredi, Samedi, Dimanche.
- Chaque jour = heures MATINÉE (de X h Y à X h Y) + APRÈS-MIDI (de X h Y à X h Y).
- Renseigne la structure « jours » avec matinDebut / matinFin / amDebut / amFin (HH:MM).
- Mets "type": "heures".

FORMAT B — « BORDEREAU DE PRÉSENCE » (mensuel avec croix X) :
- Titre visible : « BORDEREAU DE PRÉSENCE »
- Table avec 30 ou 31 lignes numérotées (1 au 30/31 du mois).
- Deux colonnes par jour : MATINÉE et APRÈS-MIDI (avec signatures / croix).
- Si « X » (ou signature, ou croix) dans MATINÉE → demi-journée matin travaillée (= 3.5 h).
- Si « X » (ou signature) dans APRÈS-MIDI → demi-journée après-midi travaillée (= 3.5 h).
- Si les deux → journée complète (= 7 h).
- Cellule vide ou rayée → jour non travaillé.
- Renseigne la structure « presenceDays » (voir schéma) à la place de « jours ».
- Renseigne aussi le « mois » (1..12) et « annee » à partir des champs « MOIS DE » et « ANNÉE ».
- Mets "type": "presence".

RÈGLE ABSOLUE N°1 : NE JAMAIS INVENTER DE DONNÉES.
Si tu ne vois pas une information sur l'image, mets null. NE DEVINE PAS.
Si une case est vide sur le bordereau, le jour n'est PAS travaillé → tous ses champs horaires = null.
Un jour non travaillé n'est PAS "doute" : c'est juste null. Ne mets pas de doute pour du null.

RÈGLE ABSOLUE N°2 : NE JAMAIS ALTÉRER LE NOM OU PRÉNOM.
Lis exactement ce qui est écrit. Si tu hésites entre deux lettres, mets la plus probable ET ajoute "nom" ou "prenom" dans les "doutesGlobaux".
Les prénoms français courants : Benoît, Pierre, Marie, Jean, etc. Tu peux t'en servir pour arbitrer une lettre douteuse, mais ne remplace JAMAIS un nom par un autre.

RÈGLE ABSOLUE N°3 : LECTURE RIGOUREUSE DES CHIFFRES D'HEURE.
Le PREMIER CHIFFRE d'une heure est critique : "02:32" et "22:32" désignent des horaires très différents.

Repères visuels pour les chiffres manuscrits français :
- "1" manuscrit FR : un simple bâton oblique, souvent écrit comme un petit chevron "^" ou "Λ" — PAS de boucle, PAS d'empattement horizontal en bas. Deux "1" côte à côte ressemblent à "ΛΛ" ou "nn".
- "2" manuscrit FR : une boucle marquée en haut PUIS un trait horizontal ou bouclé en bas. A toujours une courbure, pas un simple bâton.
- "0" manuscrit FR : ovale fermé, continu, plus petit et plus rond qu'un "2".
- "7" manuscrit FR : un trait horizontal en haut suivi d'un trait oblique. Souvent barré au milieu. Se confond PARFOIS avec "1" mais a la barre horizontale distinctive.

ERREURS FRÉQUENTES À ÉVITER :
- Ne JAMAIS lire "1" comme "2" : un 1 n'a pas de boucle. Si tu vois un chevron simple, c'est un 1.
- Ne JAMAIS lire "0" comme "2" : un 0 est continu et fermé, un 2 a une ouverture nette.
- Les shifts de nuit FINISSENT FRÉQUEMMENT à 02:00, 01:30, 02:32 (après minuit) — ce n'est PAS anormal.
- En cas de doute sur un chiffre (0/2, 1/2, 1/7, 8/0), METS la valeur la plus probable ET ajoute le champ dans "doutes".
- Vérifie la cohérence : si matinFin=12:31 et amDebut=14:26 et amFin semble commencer par "0", c'est probablement un shift qui se termine après minuit.

Renvoie UNIQUEMENT un JSON valide au schéma suivant, sans texte avant/après, sans balises markdown.

Pour FORMAT A (bordereau d'heures) :
{
  "type": "heures",
  "nom": string,
  "prenom": string,
  "client": string | null,
  "semaineDu": "YYYY-MM-DD" | null,
  "semaineAu": "YYYY-MM-DD" | null,
  "doutesGlobaux": ["nom", "prenom", "semaineDu", ...],
  "jours": [
    {
      "jour": "lundi" | "mardi" | "mercredi" | "jeudi" | "vendredi" | "samedi" | "dimanche",
      "date": "YYYY-MM-DD" | null,
      "matinDebut": "HH:MM" | null,
      "matinFin": "HH:MM" | null,
      "amDebut": "HH:MM" | null,
      "amFin": "HH:MM" | null,
      "ferie": false,
      "doutes": ["matinDebut", ...]
    }
  ],
  "observationsClient": string | null,
  "signe": boolean
}

Pour FORMAT B (bordereau de présence) :
{
  "type": "presence",
  "nom": string,
  "prenom": string,
  "client": string | null,
  "mois": 1..12,            // numérique
  "annee": 2026,            // numérique
  "doutesGlobaux": ["nom", "prenom", "mois", ...],
  "presenceDays": [
    { "day": 1, "matin": true|false, "apresMidi": true|false, "doutes": ["matin", "apresMidi"] },
    { "day": 2, ... },
    ...
  ],
  "observationsClient": string | null,
  "signe": boolean
}

Règles détaillées :
1. Un jour SANS aucune heure visible → tous null, doutes=[], ferie=false. Point. Ne pas inventer.
2. Un jour AVEC des heures : lis-les. Si un chiffre est ambigu (ex : 9 vs 4), mets la valeur la plus probable et ajoute le champ dans "doutes".
3. Format horaire : toujours "HH:MM" sur 24h (ex "09:00", "21:30", "23:51", "02:32").
4. Format bordereau français : les heures peuvent être écrites "9H00" ou "13h27" ou "13 h 27" → convertis en HH:MM.
5. "MATINÉE — ARRIVÉE / PAUSE REPAS" = matinDebut / matinFin.
6. "APRÈS-MIDI — RETOUR PAUSE / DÉPART" = amDebut / amFin. Peut finir après minuit (shift de nuit).
7. Si la semaine porte "DU JJ/MM/YYYY AU JJ/MM/YYYY", remplis semaineDu et semaineAu au format YYYY-MM-DD EXACTEMENT tels qu'écrits — même si la date de début n'est pas un lundi (ex : un bordereau peut commencer un mercredi quand le 1er du mois tombe un mercredi). Le client calera au lundi.
8. NE PAS calculer les dates par jour si elles ne sont pas explicitement écrites sur le bordereau. Laisse "date": null et laisse le client calculer à partir de semaineDu.
9. Jours fériés : cocher ferie=true UNIQUEMENT si explicitement marqué "férié" sur le bordereau.
10. N'invente AUCUN client si la raison sociale n'est pas lisible → client=null.
11. NE RENVOIE RIEN D'AUTRE QUE LE JSON.`;

const MOIS_FR = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];

function buildSystemPrompt(moisReference) {
  if (!moisReference) return SYSTEM_PROMPT_BASE;
  // moisReference au format "YYYY-MM"
  const [y, m] = moisReference.split('-').map(Number);
  if (!y || !m) return SYSTEM_PROMPT_BASE;
  const moisNom = MOIS_FR[m - 1];
  const hint = `

INDICE CONTEXTUEL : ce bordereau concerne obligatoirement ${moisNom} ${y} (mois de paie). Si la date "DU ... AU ..." manuscrite est illisible ou ambiguë, mets semaineDu=null et ajoute "semaineDu" à doutesGlobaux — ne JAMAIS inventer une date hors de ${moisNom} ${y}. Si tu lis clairement une date hors de ${moisNom} ${y}, c'est probablement une erreur de lecture : mets semaineDu=null et signale le doute.`;
  return SYSTEM_PROMPT_BASE + hint;
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = reader.result;
      const b64 = s.split(',')[1];
      resolve(b64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function mediaTypeOf(file) {
  const t = (file.type || '').toLowerCase();
  if (t === 'image/jpeg' || t === 'image/jpg') return 'image/jpeg';
  if (t === 'image/png') return 'image/png';
  if (t === 'image/webp') return 'image/webp';
  if (t === 'image/gif') return 'image/gif';
  if (t === 'application/pdf') return 'application/pdf';
  // fallback par extension
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

export async function ocrBordereau(file, { moisReference } = {}) {
  const b64 = await fileToBase64(file);
  const mediaType = mediaTypeOf(file);
  const isPdf = mediaType === 'application/pdf';

  const content = [
    {
      type: isPdf ? 'document' : 'image',
      source: { type: 'base64', media_type: mediaType, data: b64 },
    },
    { type: 'text', text: 'Extrait les données de ce bordereau au format JSON selon le schéma indiqué.' },
  ];

  const body = {
    model: MODEL,
    max_tokens: 2000,
    system: buildSystemPrompt(moisReference),
    messages: [{ role: 'user', content }],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Proxy/Claude ${res.status}: ${err}`);
  }
  const data = await res.json();
  const text = (data.content || []).map(c => c.text || '').join('').trim();
  return JSON.parse(extractFirstJsonObject(text));
}

// Extrait le premier objet JSON top-level du texte Claude, même si entouré
// de markdown fences ou suivi d'explications. Suit la balance des { } en
// respectant les strings pour ignorer les accolades échappées.
function extractFirstJsonObject(raw) {
  let text = String(raw || '').trim();
  // Strip markdown fences ```json ... ```
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error('Réponse Claude non-JSON (aucun {): ' + text.slice(0, 200));
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = false; continue; }
    } else {
      if (c === '"') { inStr = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  throw new Error('JSON Claude non équilibré (accolades déséquilibrées): ' + text.slice(0, 200));
}
