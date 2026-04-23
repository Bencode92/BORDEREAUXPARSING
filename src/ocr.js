// OCR via Claude Vision API, à travers le Worker Cloudflare studyforge-proxy.
// La clé Anthropic est stockée en secret côté Worker (env.ANTHROPIC_API_KEY) :
// le navigateur ne la voit jamais.

const API_URL = 'https://studyforge-proxy.benoit-comas.workers.dev/';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT_BASE = `Tu es un extracteur de données pour des bordereaux d'heures d'intérimaires français (agence Cameleons RH).

RÈGLE ABSOLUE N°1 : NE JAMAIS INVENTER DE DONNÉES.
Si tu ne vois pas une information sur l'image, mets null. NE DEVINE PAS.
Si une case est vide sur le bordereau, le jour n'est PAS travaillé → tous ses champs horaires = null.
Un jour non travaillé n'est PAS "doute" : c'est juste null. Ne mets pas de doute pour du null.

RÈGLE ABSOLUE N°2 : NE JAMAIS ALTÉRER LE NOM OU PRÉNOM.
Lis exactement ce qui est écrit. Si tu hésites entre deux lettres, mets la plus probable ET ajoute "nom" ou "prenom" dans les "doutesGlobaux".
Les prénoms français courants : Benoît, Pierre, Marie, Jean, etc. Tu peux t'en servir pour arbitrer une lettre douteuse, mais ne remplace JAMAIS un nom par un autre.

RÈGLE ABSOLUE N°3 : LECTURE RIGOUREUSE DES CHIFFRES D'HEURE.
Le PREMIER CHIFFRE d'une heure est critique : "02:32" et "22:32" désignent des horaires très différents.
- Un "0" manuscrit est rond et fermé, plus petit que "2".
- Un "2" manuscrit a une boucle/angle plus marqué en haut et une base droite.
- Les shifts de nuit FINISSENT FRÉQUEMMENT à 02:00, 01:30, 02:32 (après minuit) — ce n'est PAS anormal.
- En cas de doute sur le premier chiffre (0 vs 2, 1 vs 7, 8 vs 0), METS la valeur la plus probable ET ajoute le champ dans "doutes".
- Vérifie la cohérence avec l'heure de début : si matinFin=12:31 et amDebut=14:26 et amFin semble commencer par "0", c'est probablement un shift qui se termine après minuit.

Renvoie UNIQUEMENT un JSON valide au schéma suivant, sans texte avant/après, sans balises markdown :

{
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

Règles détaillées :
1. Un jour SANS aucune heure visible → tous null, doutes=[], ferie=false. Point. Ne pas inventer.
2. Un jour AVEC des heures : lis-les. Si un chiffre est ambigu (ex : 9 vs 4), mets la valeur la plus probable et ajoute le champ dans "doutes".
3. Format horaire : toujours "HH:MM" sur 24h (ex "09:00", "21:30", "23:51", "02:32").
4. Format bordereau français : les heures peuvent être écrites "9H00" ou "13h27" ou "13 h 27" → convertis en HH:MM.
5. "MATINÉE — ARRIVÉE / PAUSE REPAS" = matinDebut / matinFin.
6. "APRÈS-MIDI — RETOUR PAUSE / DÉPART" = amDebut / amFin. Peut finir après minuit (shift de nuit).
7. Si la semaine porte "DU JJ/MM/YYYY AU JJ/MM/YYYY", remplis semaineDu et semaineAu au format YYYY-MM-DD.
8. Si semaineDu est rempli et que les dates par jour ne sont pas explicitement écrites, calcule les dates (lundi=semaineDu, mardi=+1, etc.).
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
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Réponse Claude non-JSON: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}
