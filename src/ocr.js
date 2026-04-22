// OCR via Claude Vision API, à travers le Worker Cloudflare studyforge-proxy.
// La clé Anthropic est stockée en secret côté Worker (env.ANTHROPIC_API_KEY) :
// le navigateur ne la voit jamais.

const API_URL = 'https://studyforge-proxy.benoit-comas.workers.dev/';
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT = `Tu es un extracteur de données pour des bordereaux d'heures d'intérimaires (agence Cameleons RH).
Lis l'image et renvoie UNIQUEMENT un JSON valide au schéma suivant, sans texte avant/après, sans balises markdown.

Schéma :
{
  "nom": string,
  "prenom": string,
  "client": string (raison sociale),
  "semaineDu": "YYYY-MM-DD" (lundi),
  "semaineAu": "YYYY-MM-DD" (dimanche),
  "jours": [
    {
      "jour": "lundi" | "mardi" | ... | "dimanche",
      "date": "YYYY-MM-DD" | null,
      "matinDebut": "HH:MM" | null,
      "matinFin": "HH:MM" | null,
      "amDebut": "HH:MM" | null,
      "amFin": "HH:MM" | null,
      "ferie": boolean,
      "doutes": ["matinDebut", "amFin", ...]  // liste des champs dont la lecture est incertaine
    }
  ],
  "observationsClient": string | null,
  "signe": boolean
}

Règles :
- Si un champ est illisible, mets la valeur la plus probable ET ajoute son nom dans "doutes".
- Si un jour n'est pas travaillé, mets tous ses champs horaires à null.
- Si la date n'est pas explicite pour chaque jour, calcule-la à partir de semaineDu.
- Heures au format 24h "HH:MM" (ex "09:00", "21:30").
- NE renvoie RIEN D'AUTRE que le JSON.`;

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

export async function ocrBordereau(file) {
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
    system: SYSTEM_PROMPT,
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
