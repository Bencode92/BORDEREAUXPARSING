-- Migration D1 v2 — dédup par hash, statut revue, suivi export
-- À exécuter : wrangler d1 execute bordereaux_prod --file=worker/schema_v2.sql --remote

-- === Nouvelles colonnes sur bordereaux ===
ALTER TABLE bordereaux ADD COLUMN file_hash       TEXT;
ALTER TABLE bordereaux ADD COLUMN status          TEXT NOT NULL DEFAULT 'pending_review';
  -- 'pending_review' | 'validated' | 'rejected'
ALTER TABLE bordereaux ADD COLUMN reviewed_by     TEXT;
ALTER TABLE bordereaux ADD COLUMN reviewed_at     TEXT;
ALTER TABLE bordereaux ADD COLUMN review_notes    TEXT;
ALTER TABLE bordereaux ADD COLUMN exported        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bordereaux ADD COLUMN exported_at     TEXT;
ALTER TABLE bordereaux ADD COLUMN export_batch_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_bordereaux_hash     ON bordereaux(file_hash);
CREATE INDEX IF NOT EXISTS idx_bordereaux_status   ON bordereaux(status);
CREATE INDEX IF NOT EXISTS idx_bordereaux_exported ON bordereaux(exported);

-- === Table de suivi des exports PLD ===
CREATE TABLE IF NOT EXISTS export_batches (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  user_email     TEXT,
  nb_bordereaux  INTEGER NOT NULL DEFAULT 0,
  period_start   TEXT,           -- min(semaine_du) des bordereaux inclus
  period_end     TEXT,            -- max(semaine_du)
  csv_r2_key     TEXT,            -- archivage du CSV PLD produit
  notes          TEXT             -- « re-export correctif batch #42 » etc.
);
CREATE INDEX IF NOT EXISTS idx_export_batches_created ON export_batches(created_at DESC);

-- === Table de suivi des fichiers rejetés (non-bordereaux, erreurs OCR, ZIPs mixtes) ===
-- Permet d'afficher au rapport post-batch « 3 fichiers non-bordereaux détectés ».
CREATE TABLE IF NOT EXISTS batch_rejects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  user_email  TEXT,
  filename    TEXT NOT NULL,
  file_hash   TEXT,
  reason      TEXT NOT NULL,     -- 'unsupported_format' | 'ocr_failed' | 'not_a_bordereau' | 'corrupt'
  details     TEXT
);
CREATE INDEX IF NOT EXISTS idx_batch_rejects_hash ON batch_rejects(file_hash);
