-- Schema D1 pour bordereaux Cameleons RH
-- À exécuter : wrangler d1 execute bordereaux_prod --file=worker/schema.sql --remote

-- ============ BORDEREAUX ============
CREATE TABLE IF NOT EXISTS bordereaux (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nom             TEXT NOT NULL,
  prenom          TEXT NOT NULL,
  matricule       TEXT,
  client          TEXT,
  contrat_defaut  TEXT,
  semaine_du      TEXT NOT NULL,       -- YYYY-MM-DD
  semaine_au      TEXT NOT NULL,
  total_ht        REAL DEFAULT 0,      -- centièmes
  total_hn        REAL DEFAULT 0,
  jours_json      TEXT NOT NULL,       -- JSON : détail par jour
  csv_pld         TEXT,                -- CSV final PLD
  pdf_r2_key      TEXT,                -- clé du PDF/image originale dans R2
  source          TEXT NOT NULL,       -- 'ocr' | 'manual'
  validated_by    TEXT,                -- email de la personne qui a validé
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bordereaux_person   ON bordereaux(nom, prenom);
CREATE INDEX IF NOT EXISTS idx_bordereaux_semaine  ON bordereaux(semaine_du);
CREATE INDEX IF NOT EXISTS idx_bordereaux_created  ON bordereaux(created_at);

-- ============ INTERIMAIRES (base Notion) ============
CREATE TABLE IF NOT EXISTS intermediaires (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  nom                   TEXT NOT NULL,        -- COMAS
  prenom                TEXT NOT NULL,        -- BENOIT
  matricule_notion      TEXT,                 -- N Interim (ex "3128")
  full_name_norm        TEXT NOT NULL,        -- "benoit comas" (sans accent, minuscule, pour fuzzy search)
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(nom, prenom)
);
CREATE INDEX IF NOT EXISTS idx_interm_fullname ON intermediaires(full_name_norm);

-- ============ CONTRATS (liés aux intérimaires) ============
CREATE TABLE IF NOT EXISTS contrats (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  intermediaire_id  INTEGER NOT NULL,
  numero_contrat    TEXT NOT NULL,         -- "46544"
  avenant           INTEGER NOT NULL DEFAULT 0, -- "46544,1" → avenant=1
  client            TEXT,                  -- "CHRISTIAN DIOR COUTURE"
  date_debut        TEXT,                  -- YYYY-MM-DD
  date_fin          TEXT,                  -- YYYY-MM-DD ou NULL (contrat en cours)
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (intermediaire_id) REFERENCES intermediaires(id) ON DELETE CASCADE,
  UNIQUE(intermediaire_id, numero_contrat, avenant)
);
CREATE INDEX IF NOT EXISTS idx_contrats_interm  ON contrats(intermediaire_id);
CREATE INDEX IF NOT EXISTS idx_contrats_period  ON contrats(date_debut, date_fin);
CREATE INDEX IF NOT EXISTS idx_contrats_client  ON contrats(client);

-- ============ HISTORIQUE DES IMPORTS CSV ============
CREATE TABLE IF NOT EXISTS import_snapshots (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  import_date              TEXT NOT NULL DEFAULT (datetime('now')),
  filename                 TEXT,                  -- nom du fichier tel qu'uploadé
  r2_key                   TEXT,                  -- clé R2 du CSV archivé
  nb_lignes_csv            INTEGER DEFAULT 0,     -- lignes parsées avec succès
  nb_inter_inserted        INTEGER DEFAULT 0,
  nb_inter_updated         INTEGER DEFAULT 0,
  nb_contrats_inserted     INTEGER DEFAULT 0,
  nb_contrats_updated      INTEGER DEFAULT 0,
  user_email               TEXT,
  errors_json              TEXT                   -- erreurs de parsing si any
);
CREATE INDEX IF NOT EXISTS idx_snap_date ON import_snapshots(import_date DESC);

-- ============ AUDIT LOG (RGPD) ============
CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  action         TEXT NOT NULL,   -- 'create' | 'read' | 'update' | 'delete'
                                  -- | 'rgpd_export' | 'rgpd_forget' | 'auto_purge'
  bordereau_id   INTEGER,
  user_email     TEXT,
  ip_hash        TEXT,             -- SHA-256 de l'IP (pas l'IP en clair)
  details_json   TEXT,
  timestamp      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_bord      ON audit_log(bordereau_id);
CREATE INDEX IF NOT EXISTS idx_audit_ts        ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_action    ON audit_log(action);
