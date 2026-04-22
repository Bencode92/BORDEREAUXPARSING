# Déploiement — Bordereaux Cameleons

Guide pas-à-pas pour déployer le stockage D1 + R2 et mettre à jour le Worker studyforge-proxy.

Prérequis : Node.js + [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installé, connecté au compte Cloudflare (`wrangler login`).

## 1. Créer la base D1 (jurisdiction EU — garantie RGPD)

```bash
wrangler d1 create bordereaux_prod --jurisdiction eu
```

`--jurisdiction eu` est une **contrainte forte** (les données sont restreintes à l'UE pour conformité), supérieure à `--location` (simple optimisation perf).

Cette commande affiche un `database_id`. **Copiez-le** dans `worker/wrangler.toml` à la ligne `database_id = "..."`.

Puis appliquez le schéma :

```bash
cd worker
wrangler d1 execute bordereaux_prod --file=schema.sql --remote
```

## 2. Créer le bucket R2 (jurisdiction EU)

```bash
wrangler r2 bucket create bordereaux-pdf --jurisdiction eu
```

La `jurisdiction eu` garantit que les données restent dans les datacenters européens.

## 3. Définir le secret d'authentification équipe

```bash
# Générer un token fort (ex : openssl rand -hex 32)
openssl rand -hex 32
# → copier le résultat

wrangler secret put BORDEREAUX_AUTH_TOKEN
# → coller le token quand demandé
```

Partagez ce token uniquement avec les membres de l'équipe Cameleons autorisés à saisir.

(Optionnel) salt pour le hachage des IP dans l'audit :
```bash
wrangler secret put AUDIT_SALT
# → ex : openssl rand -hex 16
```

## 4. Déployer le Worker

```bash
cd worker
wrangler deploy
```

Le Worker `studyforge-proxy` est mis à jour avec :
- les routes `/bordereaux/*` (save, list, get, pdf, delete, rgpd/*)
- le handler cron `scheduled()` (purge > 5 ans à 03h UTC)
- les bindings `DB` (D1) et `BUCKET` (R2)

## 5. Vérifier

### Ping auth
```bash
curl -X GET https://studyforge-proxy.benoit-comas.workers.dev/bordereaux/list \
  -H "X-Auth-Token: <votre-token>" \
  -H "X-User-Email: vous@cameleons.fr"
```
Réponse attendue : `{"bordereaux":[]}`

### Créer un bordereau test
```bash
curl -X POST https://studyforge-proxy.benoit-comas.workers.dev/bordereaux/save \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: <votre-token>" \
  -H "X-User-Email: vous@cameleons.fr" \
  -d '{
    "nom":"TEST","prenom":"Test",
    "semaineDu":"2026-04-20","semaineAu":"2026-04-26",
    "totalHt":8.5,"totalHn":0,
    "jours":[{"date":"2026-04-20","totalHt":8.5,"totalHn":0}],
    "source":"manual"
  }'
```

## 6. Configurer le frontend

Ouvrez `index.html` :
1. Saisissez votre email + token équipe (section 0)
2. Chargez un bordereau, validez, cliquez « Archiver »

## 7. Monitoring

- Logs en direct : `wrangler tail`
- Dashboard : https://dash.cloudflare.com/ → Workers → studyforge-proxy → Logs
- Consulter la base : `wrangler d1 execute bordereaux_prod --command "SELECT COUNT(*) FROM bordereaux" --remote`

## 8. Rotation des secrets

Si le token équipe est compromis :
```bash
wrangler secret put BORDEREAUX_AUTH_TOKEN
# → nouveau token
# → redistribuer aux membres autorisés
```

## 9. Sauvegarde D1 (recommandé)

Cloudflare D1 fait des snapshots automatiques (Time Travel, 30 jours). Pour des exports réguliers :

```bash
wrangler d1 export bordereaux_prod --remote --output=backup-$(date +%Y%m%d).sql
```

À lancer manuellement (ou via cron local) au moins 1 fois par mois.
