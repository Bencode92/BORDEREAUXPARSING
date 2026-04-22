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
