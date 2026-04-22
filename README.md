# BORDEREAUXPARSING — Cameleons RH

Outil d'automatisation du traitement des bordereaux d'heures intérimaires pour **Cameleons RH**.

## Contexte

- ~500 bordereaux/semaine (~2000/mois) à saisir manuellement dans **PLD Tempo 7**
- Bordereaux numériques (PDF, JPEG, PNG, scans) reçus depuis des sources variées
- Objectif : OCR + validation humaine + export CSV PLD, pour diviser le temps de saisie par 5-10

## Paramètres figés

| Paramètre | Valeur |
|---|---|
| Code heures jour | `HT` (06h00 → 21h00) |
| Code heures nuit | `HN` (21h00 → 06h00) |
| Format durée | Centième d'heure (ex : 10h32 → `10.53`) |
| Format date | `AAAAMMJJ` |
| CSV | `;` séparateur, `"` délimiteur, CRLF, pas d'en-têtes |
| Doutes OCR | Valeur `???` affichée en rouge, correction manuelle |
| Jours fériés | Marqués explicitement, majoration gérée par PLD |
| Matching contrat | Manuel en V1 (depuis base Notion) |

## Format CSV PLD Tempo 7

Colonnes (dans l'ordre, sans en-tête) :

```
Version ; Matricule ; Nom ; Prénom ; Date ; Contrat ; Avenant ; Code ; CodeAbsence ; Libellé ; Quantité ; Prix ; IFMICP ; FdM ; Référence
```

Exemple :
```csv
"V1";"";"COMAS";"Benoît";"20260420";"100285";"0";"HT";"";"Heures travaillées";"10.53";;;;
"V1";"";"COMAS";"Benoît";"20260421";"100285";"0";"HT";"";"Heures travaillées";"8.10";;;;
"V1";"";"COMAS";"Benoît";"20260421";"100285";"0";"HN";"";"Heures de nuit";"2.85";;;;
```

**Règle clé :** 1 ligne = 1 jour × 1 personne × 1 code. Un jour avec heures jour + nuit → 2 lignes.

## Roadmap

- **Phase 1** — POC mono-bordereau : saisie manuelle + génération CSV PLD ✅ en cours
- **Phase 2** — OCR Claude Vision : upload photo → pré-remplissage auto
- **Phase 3** — Traitement par lot (50 bordereaux d'un coup)
- **Phase 4** — Intégration Notion automatique (matching contrats)
- **Phase 5** — Industrialisation (dashboard, alertes, archivage)

## Structure

```
/
├── index.html          UI principale (formulaire + export + historique + RGPD)
├── src/
│   ├── time-split.js   Calcul heures jour/nuit (coupure 21h/6h)
│   ├── csv-pld.js      Génération CSV PLD Tempo 7
│   ├── ocr.js          Appel Worker (OCR Claude Vision)
│   ├── archive.js      Client des routes /bordereaux/* (D1 + R2)
│   └── app.js          Glue UI
├── styles/app.css
├── worker/
│   ├── worker.js       Worker Cloudflare (proxy + bordereaux + RGPD)
│   ├── schema.sql      Schéma D1 (bordereaux + audit_log)
│   └── wrangler.toml   Config Worker (bindings D1/R2, cron, EU)
├── docs/
│   ├── DEPLOYMENT.md   Pas-à-pas de déploiement
│   └── RGPD.md         Doc conformité RGPD (à valider par DPO)
└── samples/            Bordereaux de test
```

## Infrastructure

- **Frontend** : HTML/JS statique (peut tourner en local ou Cloudflare Pages)
- **Backend** : Worker Cloudflare `studyforge-proxy` (OCR proxy + routes bordereaux)
- **Stockage structuré** : Cloudflare D1 (SQLite serverless, région UE)
- **Stockage fichiers** : Cloudflare R2 (objets, jurisdiction UE)
- **OCR** : Claude Vision (Anthropic, DPA + SCCs)
- **Auth équipe** : token partagé `BORDEREAUX_AUTH_TOKEN`
- **RGPD** : routes `/rgpd/export` et `/rgpd/forget`, cron purge > 5 ans

Voir `docs/DEPLOYMENT.md` pour le déploiement et `docs/RGPD.md` pour la conformité.

## Usage (Phase 1)

1. Ouvrir `index.html` dans un navigateur
2. Saisir nom, prénom, semaine
3. Pour chaque jour travaillé : heure arrivée, pause, retour, départ
4. Les heures jour/nuit se calculent automatiquement
5. Saisir le N° de contrat (depuis Notion)
6. Bouton "Télécharger CSV" → fichier prêt pour import PLD
