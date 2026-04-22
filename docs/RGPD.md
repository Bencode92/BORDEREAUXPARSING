# Conformité RGPD — Traitement automatisé des bordereaux d'heures

**⚠️ Document brouillon à relire et valider par le DPO / référent RGPD de Cameleons RH.**

## 1. Responsable de traitement

**Cameleons RH** — [adresse à compléter]
DPO / Référent RGPD : [à compléter]

## 2. Finalités du traitement

- Extraction automatisée des données des bordereaux d'heures transmis par les clients utilisateurs
- Génération du fichier d'import vers le logiciel de paie PLD Tempo 7
- Archivage des bordereaux traités pour conservation légale et contrôle

## 3. Base légale

Article 6.1.b RGPD — **exécution d'un contrat** (contrat de mission d'intérim) + article 6.1.c RGPD — **obligation légale** (conservation des documents de paie, Code du travail L.3243-4, durée 5 ans).

## 4. Catégories de données traitées

| Donnée | Finalité | Obligatoire ? |
|---|---|---|
| Nom, prénom | Identification pour la paie | Oui |
| Matricule | Rattachement dossier | Non |
| N° contrat, avenant | Rattachement mission | Oui |
| Raison sociale client | Rattachement mission | Oui |
| Dates et heures travaillées | Calcul de la paie | Oui |
| Image du bordereau original (PDF/photo) | Preuve, audit | Oui (5 ans) |

**Aucune donnée sensible** (santé, opinions, origine, etc.) **n'est traitée.**

## 5. Sous-traitants (article 28)

| Sous-traitant | Rôle | Pays | Garanties |
|---|---|---|---|
| **Cloudflare** | Hébergement Worker, stockage D1 (SQLite) et R2 (fichiers) | UE (région forcée) | DPA signé, SCCs, ISO 27001, SOC 2 |
| **Anthropic (Claude)** | OCR des bordereaux (extraction texte/structure) | USA | DPA signé, SCCs, no training on API data |

**Actions à effectuer par Cameleons RH :**
- [ ] Signer le DPA Cloudflare : https://www.cloudflare.com/gdpr/
- [ ] Signer le DPA Anthropic : https://www.anthropic.com/legal/dpa
- [ ] Vérifier l'activation de la Data Localisation EU sur Cloudflare
- [ ] Confirmer le paramétrage « no training » sur le compte Anthropic

## 6. Durée de conservation

| Donnée | Durée | Base |
|---|---|---|
| Bordereaux (D1 + R2) | 5 ans à compter de la fin de la mission | Code du travail L.3243-4 |
| Journal d'audit (audit_log) | 1 an | Usage interne |

**Mise en œuvre technique :**
- Cron quotidien (03h UTC) qui supprime les bordereaux > 5 ans (table `bordereaux` + fichiers R2)
- Purge en cascade du PDF R2 quand la ligne D1 est supprimée

## 7. Sécurité

- **Chiffrement au repos** : D1 et R2 chiffrés AES-256 par Cloudflare (activé par défaut)
- **Chiffrement en transit** : HTTPS/TLS forcé, pas de fallback HTTP
- **Authentification** : token partagé `BORDEREAUX_AUTH_TOKEN` (stocké en secret Worker, jamais exposé côté client)
- **Clés API** : `ANTHROPIC_API_KEY` stockée en secret Worker
- **IP** : hachées en SHA-256 (non stockées en clair) dans l'audit log
- **Principe de minimisation** : seules les données nécessaires à la paie sont stockées

## 8. Droits des personnes

Les intérimaires peuvent exercer :
- **Droit d'accès (art. 15)** : export de toutes leurs données via `/bordereaux/rgpd/export?nom=X&prenom=Y`
- **Droit de rectification (art. 16)** : correction sur demande écrite à [contact]
- **Droit à l'effacement (art. 17)** : suppression via `/bordereaux/rgpd/forget?nom=X&prenom=Y`
  - ⚠️ Ne supprime que les enregistrements > 5 ans. Les plus récents sont conservés au titre de l'obligation légale (art. 17.3.b RGPD).
- **Droit à la portabilité (art. 20)** : export JSON structuré (via `/rgpd/export`)
- **Droit d'opposition (art. 21)** : non applicable (traitement obligatoire contractuellement/légalement)

**Contact pour exercer ces droits :** [email DPO à définir]

**Délai de réponse légal :** 1 mois (prorogeable à 3 mois si complexe, article 12.3 RGPD).

## 9. Transferts hors UE

Un seul transfert hors UE : vers Anthropic (USA) le temps du traitement OCR.

Garanties :
- Clauses Contractuelles Types (SCCs) de la Commission européenne signées dans le DPA Anthropic
- Le traitement est temporaire (le temps de l'appel API, pas de stockage côté Anthropic)
- Option « no training » activée (API commerciale)

**Alternative 100 % UE (optionnelle) :** basculer l'OCR vers **Mistral Vision / Pixtral** (serveurs français) si souhaité. Prévu en feature flag dans le Worker.

## 10. Information des personnes (article 13)

Mention à intégrer au contrat de mission d'intérim ou à la notice d'information RH :

> *« Les données figurant sur vos bordereaux d'heures sont traitées par Cameleons RH pour la gestion de votre rémunération et la conservation des justificatifs de paie. L'extraction automatisée des heures est réalisée via le service Anthropic (USA) avec garanties appropriées (SCCs). Vos données sont hébergées dans l'Union Européenne (Cloudflare, région UE). Elles sont conservées 5 ans, conformément à l'obligation légale de conservation des documents de paie. Vous disposez d'un droit d'accès, de rectification, de portabilité et, à l'issue du délai légal, d'un droit à l'effacement — à exercer auprès de [contact DPO]. Vous pouvez introduire une réclamation auprès de la CNIL (cnil.fr). »*

## 11. Registre des activités de traitement (article 30)

Fiche à ajouter au registre de Cameleons RH :

| Rubrique | Contenu |
|---|---|
| Nom du traitement | Traitement automatisé des bordereaux d'heures intérimaires |
| Finalités | Gestion de la paie, génération CSV PLD, archivage légal |
| Base légale | Exécution contractuelle + obligation légale |
| Catégories de personnes | Intérimaires de Cameleons RH |
| Catégories de données | Identification, contrat, heures travaillées, image du bordereau |
| Destinataires | Équipe paie Cameleons, logiciel PLD Tempo 7 |
| Transferts hors UE | Oui, ponctuel, Anthropic (USA) avec SCCs |
| Durée de conservation | 5 ans |
| Sous-traitants | Cloudflare (UE), Anthropic (USA) |
| Mesures de sécurité | Chiffrement AES-256, HTTPS, auth par token, audit log, IP hachées |

## 12. Analyse d'impact (DPIA)

Une **DPIA n'est pas obligatoire** pour ce traitement :
- Pas de traitement à grande échelle de données sensibles
- Pas de décision entièrement automatisée avec effet juridique (toute donnée OCR est validée manuellement)
- Pas de profilage, pas de scoring

Une analyse légère peut néanmoins être réalisée pour documenter les choix (voir fichier `docs/analyse-risques.md` à créer si souhaité).

## 13. Violation de données (article 33)

En cas de fuite ou d'accès non autorisé :
1. **Rotation immédiate** du token `BORDEREAUX_AUTH_TOKEN` (`wrangler secret put`)
2. Analyse des logs Worker (Cloudflare dashboard)
3. Notification CNIL dans les **72h** si risque pour les personnes
4. Notification aux intérimaires concernés si risque élevé
5. Enregistrement interne de l'incident

## 14. Check-list d'audit interne

- [ ] DPA Cloudflare signé
- [ ] DPA Anthropic signé
- [ ] D1 créée en région `eu`
- [ ] R2 créé avec `jurisdiction=eu`
- [ ] Token auth en secret Worker (pas en clair dans le code)
- [ ] Cron de purge actif et monitoré
- [ ] Audit log accessible au DPO
- [ ] Notice RGPD intégrée aux contrats de mission
- [ ] Registre de traitement à jour
- [ ] Procédure de rotation du token documentée
- [ ] Contact DPO défini et communiqué
