// studyforge-proxy — Worker Cloudflare
// Contient les proxies existants (GitHub, TwelveData, DVF, BdF, Claude)
// + Routes Bordereaux Cameleons (D1 + R2 + RGPD + audit)
//
// ENV attendues :
//   ANTHROPIC_API_KEY, GITHUB_TOKEN, TWELVE_DATA_API_KEY, FRENCH_API
//   BORDEREAUX_AUTH_TOKEN  (nouveau : token partagé équipe Cameleons)
// Bindings :
//   DB      (D1 bordereaux_prod, région eu)
//   BUCKET  (R2 bordereaux-pdf, jurisdiction eu)

const CORS_BASE = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Auth-Token, X-User-Email",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

const JSON_H = { ...CORS_BASE, "Content-Type": "application/json" };

// ====== Helpers ======
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_H });
}

async function sha256(text) {
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function audit(env, { action, bordereauId = null, userEmail = null, ip = null, details = null }) {
  const ipHash = ip ? await sha256(ip + (env.AUDIT_SALT || "cameleons")) : null;
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (action, bordereau_id, user_email, ip_hash, details_json) VALUES (?, ?, ?, ?, ?)"
    ).bind(action, bordereauId, userEmail, ipHash, details ? JSON.stringify(details) : null).run();
  } catch (e) {
    console.error("audit fail", e);
  }
}

function requireAuth(request, env) {
  const token = request.headers.get("X-Auth-Token");
  if (!env.BORDEREAUX_AUTH_TOKEN) return { ok: false, err: json({ error: "BORDEREAUX_AUTH_TOKEN not configured" }, 500) };
  if (token !== env.BORDEREAUX_AUTH_TOKEN) return { ok: false, err: json({ error: "Unauthorized" }, 401) };
  return { ok: true, user: request.headers.get("X-User-Email") || "unknown" };
}

function getIp(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || null;
}

// ====== Fuzzy matching helpers ======
function normalizeName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const n = a.length, m = b.length;
  if (!n) return m; if (!m) return n;
  const prev = new Array(m + 1);
  const cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= m; j++) prev[j] = cur[j];
  }
  return prev[m];
}

function similarityScore(a, b) {
  const an = normalizeName(a);
  const bn = normalizeName(b);
  if (!an || !bn) return 0;
  const maxLen = Math.max(an.length, bn.length);
  const dist = levenshtein(an, bn);
  return 1 - dist / maxLen; // 1.0 = identique, 0 = totalement différent
}

// ====== Routes BORDEREAUX ======
async function handleBordereaux(request, env, url) {
  const auth = requireAuth(request, env);
  if (!auth.ok) return auth.err;
  const user = auth.user;
  const ip = getIp(request);

  const sub = url.pathname.replace(/^\/bordereaux\/?/, "");
  const method = request.method;

  // ============ INTERIMAIRES (base Notion) ============

  // POST /bordereaux/interimaires/import
  // Body : { rows, csvRaw (base64), filename, errors }
  if (sub === "interimaires/import" && method === "POST") {
    const { rows, csvRaw, filename, errors } = await request.json();
    if (!Array.isArray(rows)) return json({ error: "rows requis (array)" }, 400);

    const stats = { intermediaires: { inserted: 0, updated: 0 }, contrats: { inserted: 0, updated: 0 } };
    for (const r of rows) {
      if (!r.nom || !r.prenom) continue;
      const fullNorm = normalizeName(`${r.prenom} ${r.nom}`);
      // Upsert intermediaire
      const existing = await env.DB.prepare(
        "SELECT id FROM intermediaires WHERE nom = ? AND prenom = ?"
      ).bind(r.nom, r.prenom).first();
      let intermId;
      if (existing) {
        intermId = existing.id;
        await env.DB.prepare(
          "UPDATE intermediaires SET matricule_notion=?, full_name_norm=?, updated_at=datetime('now') WHERE id=?"
        ).bind(r.matricule || null, fullNorm, intermId).run();
        stats.intermediaires.updated++;
      } else {
        const res = await env.DB.prepare(
          "INSERT INTO intermediaires (nom, prenom, matricule_notion, full_name_norm) VALUES (?, ?, ?, ?)"
        ).bind(r.nom, r.prenom, r.matricule || null, fullNorm).run();
        intermId = res.meta.last_row_id;
        stats.intermediaires.inserted++;
      }
      // Upsert contrat
      if (r.numero) {
        const existingC = await env.DB.prepare(
          "SELECT id FROM contrats WHERE intermediaire_id=? AND numero_contrat=? AND avenant=?"
        ).bind(intermId, r.numero, r.avenant || 0).first();
        if (existingC) {
          await env.DB.prepare(
            "UPDATE contrats SET client=?, date_debut=?, date_fin=?, updated_at=datetime('now') WHERE id=?"
          ).bind(r.client || null, r.debut || null, r.fin || null, existingC.id).run();
          stats.contrats.updated++;
        } else {
          await env.DB.prepare(
            "INSERT INTO contrats (intermediaire_id, numero_contrat, avenant, client, date_debut, date_fin) VALUES (?, ?, ?, ?, ?, ?)"
          ).bind(intermId, r.numero, r.avenant || 0, r.client || null, r.debut || null, r.fin || null).run();
          stats.contrats.inserted++;
        }
      }
    }

    // Archive CSV en R2 + enregistrement snapshot
    let r2Key = null;
    if (csvRaw) {
      const now = new Date();
      const y = now.getUTCFullYear();
      const m = String(now.getUTCMonth() + 1).padStart(2, "0");
      const d = String(now.getUTCDate()).padStart(2, "0");
      const ts = now.toISOString().replace(/[:.]/g, "-");
      const safe = (filename || "import.csv").replace(/[^A-Za-z0-9._-]/g, "_");
      r2Key = `imports/${y}/${m}/${d}/${ts}-${safe}`;
      const bytes = Uint8Array.from(atob(csvRaw), c => c.charCodeAt(0));
      await env.BUCKET.put(r2Key, bytes, {
        httpMetadata: { contentType: "text/csv; charset=utf-8" },
      });
    }
    const snapRes = await env.DB.prepare(`
      INSERT INTO import_snapshots
      (filename, r2_key, nb_lignes_csv,
       nb_inter_inserted, nb_inter_updated,
       nb_contrats_inserted, nb_contrats_updated,
       user_email, errors_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      filename || null, r2Key, rows.length,
      stats.intermediaires.inserted, stats.intermediaires.updated,
      stats.contrats.inserted, stats.contrats.updated,
      user, errors && errors.length ? JSON.stringify(errors) : null
    ).run();

    await audit(env, { action: "import_intermediaires", userEmail: user, ip, details: { ...stats, snapshotId: snapRes.meta.last_row_id } });
    return json({ ok: true, stats, snapshotId: snapRes.meta.last_row_id });
  }

  // GET /bordereaux/interimaires/snapshots
  if (sub === "interimaires/snapshots" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT id, import_date, filename, nb_lignes_csv,
              nb_inter_inserted, nb_inter_updated,
              nb_contrats_inserted, nb_contrats_updated,
              user_email, r2_key IS NOT NULL as has_csv
       FROM import_snapshots
       ORDER BY import_date DESC
       LIMIT 500`
    ).all();
    return json({ snapshots: results });
  }

  // GET /bordereaux/interimaires/snapshot/:id/download
  if (/^interimaires\/snapshot\/\d+\/download$/.test(sub) && method === "GET") {
    const id = parseInt(sub.split("/")[2], 10);
    const row = await env.DB.prepare(
      "SELECT r2_key, filename FROM import_snapshots WHERE id = ?"
    ).bind(id).first();
    if (!row) return json({ error: "Snapshot introuvable" }, 404);
    if (!row.r2_key) return json({ error: "Pas de CSV archivé pour ce snapshot" }, 404);
    const obj = await env.BUCKET.get(row.r2_key);
    if (!obj) return json({ error: "CSV introuvable en R2" }, 404);
    await audit(env, { action: "snapshot_download", userEmail: user, ip, details: { id } });
    return new Response(obj.body, {
      headers: {
        ...CORS_BASE,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${row.filename || 'import.csv'}"`,
      },
    });
  }

  // GET /bordereaux/interimaires/match?q=COMAD DEMAT&date=2026-04-20&limit=5
  if (sub === "interimaires/match" && method === "GET") {
    const q = url.searchParams.get("q") || "";
    const date = url.searchParams.get("date");
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "5", 10), 20);

    // 1. Récupère tous les intermédiaires (on scorera JS-side)
    //    Pour des volumes plus grands : pré-filtrer avec LIKE sur normalisation.
    const qNorm = normalizeName(q);
    const { results } = await env.DB.prepare(
      "SELECT id, nom, prenom, matricule_notion, full_name_norm FROM intermediaires"
    ).all();

    // 2. Score chacun par similarité avec q
    const scored = results.map(r => ({
      ...r,
      score: similarityScore(qNorm, r.full_name_norm),
    }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    // 3. Pour chacun, récupère les contrats actifs sur la date demandée
    const out = [];
    for (const t of top) {
      let contrats = [];
      if (date) {
        const r = await env.DB.prepare(
          `SELECT numero_contrat, avenant, client, date_debut, date_fin
           FROM contrats
           WHERE intermediaire_id = ?
             AND (date_debut IS NULL OR date_debut <= ?)
             AND (date_fin IS NULL OR date_fin >= ?)
           ORDER BY date_debut DESC`
        ).bind(t.id, date, date).all();
        contrats = r.results;
      } else {
        const r = await env.DB.prepare(
          `SELECT numero_contrat, avenant, client, date_debut, date_fin
           FROM contrats WHERE intermediaire_id = ? ORDER BY date_debut DESC`
        ).bind(t.id).all();
        contrats = r.results;
      }
      out.push({
        id: t.id, nom: t.nom, prenom: t.prenom, matricule: t.matricule_notion,
        score: Math.round(t.score * 100) / 100,
        contrats,
      });
    }
    await audit(env, { action: "match_intermediaire", userEmail: user, ip, details: { q, date, found: out.length } });
    return json({ query: q, date, matches: out });
  }

  // GET /bordereaux/interimaires/list?limit=100
  if (sub === "interimaires/list" && method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 1000);
    const { results } = await env.DB.prepare(
      `SELECT i.id, i.nom, i.prenom, i.matricule_notion,
              COUNT(c.id) as nb_contrats,
              MAX(c.date_fin) as derniere_fin,
              json_group_array(
                CASE WHEN c.id IS NOT NULL THEN
                  json_object(
                    'numero',  c.numero_contrat,
                    'avenant', c.avenant,
                    'client',  c.client,
                    'debut',   c.date_debut,
                    'fin',     c.date_fin
                  )
                END
              ) as contrats_json
       FROM intermediaires i
       LEFT JOIN contrats c ON c.intermediaire_id = i.id
       GROUP BY i.id
       ORDER BY i.nom, i.prenom
       LIMIT ?`
    ).bind(limit).all();

    // Parse le JSON côté serveur pour renvoyer un vrai tableau propre
    const clean = results.map(r => {
      let contrats = [];
      try {
        contrats = JSON.parse(r.contrats_json || "[]").filter(Boolean);
        contrats.sort((a, b) => (b.fin || b.debut || '').localeCompare(a.fin || a.debut || ''));
      } catch {}
      return {
        id: r.id, nom: r.nom, prenom: r.prenom,
        matricule_notion: r.matricule_notion,
        nb_contrats: r.nb_contrats,
        derniere_fin: r.derniere_fin,
        contrats,
      };
    });
    return json({ intermediaires: clean });
  }

  // DELETE /bordereaux/interimaires/:id
  if (sub.startsWith("interimaires/") && method === "DELETE") {
    const id = parseInt(sub.slice("interimaires/".length), 10);
    if (!id) return json({ error: "id invalide" }, 400);
    await env.DB.prepare("DELETE FROM intermediaires WHERE id = ?").bind(id).run();
    await audit(env, { action: "delete_intermediaire", userEmail: user, ip, details: { id } });
    return json({ ok: true });
  }

  // POST /bordereaux/save
  if (sub === "save" && method === "POST") {
    const body = await request.json();
    const {
      nom, prenom, matricule, client, contratDefaut,
      semaineDu, semaineAu, totalHt, totalHn,
      jours, csvPld, source, pdfBase64, pdfMediaType
    } = body;

    if (!nom || !prenom || !semaineDu) return json({ error: "nom/prenom/semaineDu requis" }, 400);

    // Upload PDF/image en R2 si présent
    let pdfKey = null;
    if (pdfBase64) {
      const year = semaineDu.slice(0, 4);
      const month = semaineDu.slice(5, 7);
      const safe = (s) => String(s).replace(/[^A-Za-z0-9-]/g, "_");
      const ext = (pdfMediaType || "").includes("pdf") ? "pdf" : "jpg";
      pdfKey = `bordereaux/${year}/${month}/${safe(nom)}-${safe(prenom)}-${semaineDu}-${Date.now()}.${ext}`;
      const bytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
      await env.BUCKET.put(pdfKey, bytes, {
        httpMetadata: { contentType: pdfMediaType || "application/octet-stream" },
      });
    }

    const res = await env.DB.prepare(`
      INSERT INTO bordereaux
      (nom, prenom, matricule, client, contrat_defaut, semaine_du, semaine_au,
       total_ht, total_hn, jours_json, csv_pld, pdf_r2_key, source, validated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      nom, prenom, matricule || null, client || null, contratDefaut || null,
      semaineDu, semaineAu || semaineDu,
      totalHt || 0, totalHn || 0,
      JSON.stringify(jours || []),
      csvPld || null, pdfKey, source || "manual", user
    ).run();

    const id = res.meta.last_row_id;
    await audit(env, { action: "create", bordereauId: id, userEmail: user, ip, details: { nom, prenom, semaineDu } });

    return json({ ok: true, id, pdfKey });
  }

  // GET /bordereaux/list?nom=&prenom=&from=&to=
  if (sub === "list" && method === "GET") {
    const params = url.searchParams;
    const nom = params.get("nom");
    const prenom = params.get("prenom");
    const from = params.get("from");
    const to = params.get("to");

    let query = "SELECT id, nom, prenom, client, semaine_du, semaine_au, total_ht, total_hn, source, validated_by, created_at FROM bordereaux WHERE 1=1";
    const binds = [];
    if (nom) { query += " AND nom = ?"; binds.push(nom); }
    if (prenom) { query += " AND prenom = ?"; binds.push(prenom); }
    if (from) { query += " AND semaine_du >= ?"; binds.push(from); }
    if (to) { query += " AND semaine_du <= ?"; binds.push(to); }
    query += " ORDER BY created_at DESC LIMIT 500";

    const { results } = await env.DB.prepare(query).bind(...binds).all();
    await audit(env, { action: "read", userEmail: user, ip, details: { filter: { nom, prenom, from, to }, count: results.length } });
    return json({ bordereaux: results });
  }

  // GET /bordereaux/get/:id
  if (sub.startsWith("get/") && method === "GET") {
    const id = parseInt(sub.slice(4), 10);
    const b = await env.DB.prepare("SELECT * FROM bordereaux WHERE id = ?").bind(id).first();
    if (!b) return json({ error: "Not found" }, 404);
    await audit(env, { action: "read", bordereauId: id, userEmail: user, ip });
    return json(b);
  }

  // GET /bordereaux/pdf/*  (serves the R2 original)
  if (sub.startsWith("pdf/") && method === "GET") {
    const key = sub.slice(4);
    const obj = await env.BUCKET.get(key);
    if (!obj) return json({ error: "PDF not found" }, 404);
    return new Response(obj.body, {
      headers: {
        ...CORS_BASE,
        "Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  // DELETE /bordereaux/delete/:id
  if (sub.startsWith("delete/") && method === "DELETE") {
    const id = parseInt(sub.slice(7), 10);
    const b = await env.DB.prepare("SELECT pdf_r2_key FROM bordereaux WHERE id = ?").bind(id).first();
    if (!b) return json({ error: "Not found" }, 404);
    if (b.pdf_r2_key) await env.BUCKET.delete(b.pdf_r2_key);
    await env.DB.prepare("DELETE FROM bordereaux WHERE id = ?").bind(id).run();
    await audit(env, { action: "delete", bordereauId: id, userEmail: user, ip });
    return json({ ok: true });
  }

  // ======== RGPD ========

  // GET /bordereaux/rgpd/export?nom=X&prenom=Y
  if (sub === "rgpd/export" && method === "GET") {
    const nom = url.searchParams.get("nom");
    const prenom = url.searchParams.get("prenom");
    if (!nom || !prenom) return json({ error: "nom et prenom requis" }, 400);
    const { results } = await env.DB.prepare(
      "SELECT * FROM bordereaux WHERE nom = ? AND prenom = ?"
    ).bind(nom, prenom).all();
    await audit(env, { action: "rgpd_export", userEmail: user, ip, details: { nom, prenom, count: results.length } });
    return json({ nom, prenom, bordereaux: results, exportedAt: new Date().toISOString() });
  }

  // DELETE /bordereaux/rgpd/forget?nom=X&prenom=Y
  // Respecte l'obligation légale : conserve les enregistrements < 5 ans (paie)
  if (sub === "rgpd/forget" && method === "DELETE") {
    const nom = url.searchParams.get("nom");
    const prenom = url.searchParams.get("prenom");
    if (!nom || !prenom) return json({ error: "nom et prenom requis" }, 400);
    const legalCutoff = new Date();
    legalCutoff.setFullYear(legalCutoff.getFullYear() - 5);
    const iso = legalCutoff.toISOString().slice(0, 19).replace("T", " ");

    const { results } = await env.DB.prepare(
      "SELECT id, pdf_r2_key FROM bordereaux WHERE nom = ? AND prenom = ? AND created_at < ?"
    ).bind(nom, prenom, iso).all();

    for (const row of results) {
      if (row.pdf_r2_key) await env.BUCKET.delete(row.pdf_r2_key);
    }
    await env.DB.prepare(
      "DELETE FROM bordereaux WHERE nom = ? AND prenom = ? AND created_at < ?"
    ).bind(nom, prenom, iso).run();

    await audit(env, {
      action: "rgpd_forget",
      userEmail: user, ip,
      details: { nom, prenom, deletedCount: results.length, legalCutoff: iso },
    });

    // Compte ce qui reste (> 5 ans de conservation légale obligatoire)
    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) as n FROM bordereaux WHERE nom = ? AND prenom = ?"
    ).bind(nom, prenom).first();

    return json({
      ok: true,
      deleted: results.length,
      retained: remaining.n,
      note: "Les enregistrements de moins de 5 ans sont conservés au titre de l'obligation légale de conservation des données de paie (Code du travail L.3243-4).",
    });
  }

  return json({ error: "Route bordereaux inconnue" }, 404);
}

// ====== Cron : purge automatique > 5 ans ======
async function purgeOld(env) {
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 5);
  const iso = cutoff.toISOString().slice(0, 19).replace("T", " ");

  const { results } = await env.DB.prepare(
    "SELECT id, pdf_r2_key FROM bordereaux WHERE created_at < ?"
  ).bind(iso).all();

  for (const row of results) {
    if (row.pdf_r2_key) {
      try { await env.BUCKET.delete(row.pdf_r2_key); } catch (e) { console.error(e); }
    }
  }
  await env.DB.prepare("DELETE FROM bordereaux WHERE created_at < ?").bind(iso).run();
  await audit(env, { action: "auto_purge", details: { count: results.length, cutoff: iso } });
  return results.length;
}

// ======================= MAIN =======================
export default {
  async scheduled(event, env) {
    // Cron : 03h00 UTC tous les jours
    await purgeOld(env);
  },

  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_BASE });

    const url = new URL(request.url);

    // ========== BORDEREAUX (nouveau) ==========
    if (url.pathname.startsWith("/bordereaux/") || url.pathname === "/bordereaux") {
      return handleBordereaux(request, env, url);
    }

    // ========== GITHUB PROXY ==========
    if (url.pathname.startsWith("/github/")) {
      let ghUrl;
      const afterGithub = url.pathname.replace("/github/", "");
      if (afterGithub.startsWith("contents/")) {
        ghUrl = "https://api.github.com/repos/Bencode92/studyforge/" + afterGithub;
      } else {
        ghUrl = "https://api.github.com/repos/" + afterGithub;
      }
      const ghHeaders = {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": "token " + env.GITHUB_TOKEN,
        "Content-Type": "application/json",
        "User-Agent": "StructBoard-Worker",
      };
      let resp;
      if (request.method === "GET") resp = await fetch(ghUrl, { headers: ghHeaders });
      else if (request.method === "PUT") resp = await fetch(ghUrl, { method: "PUT", headers: ghHeaders, body: await request.text() });
      else if (request.method === "DELETE") resp = await fetch(ghUrl, { method: "DELETE", headers: ghHeaders, body: await request.text() });
      else return json({ error: "Method not allowed" }, 405);
      return new Response(await resp.text(), { status: resp.status, headers: JSON_H });
    }

    // ========== TWELVE DATA ==========
    if (url.pathname.startsWith("/twelvedata/")) {
      const tdPath = url.pathname.replace("/twelvedata/", "");
      const params = url.search ? url.search + "&apikey=" + env.TWELVE_DATA_API_KEY : "?apikey=" + env.TWELVE_DATA_API_KEY;
      try {
        const resp = await fetch("https://api.twelvedata.com/" + tdPath + params);
        return new Response(await resp.text(), { headers: JSON_H });
      } catch (e) {
        return json({ status: "error", message: e.message }, 502);
      }
    }

    // ========== DVF ==========
    if (url.pathname.startsWith("/dvf/")) {
      const dep = url.searchParams.get("dep");
      if (!dep) return json({ error: "Missing dep parameter" }, 400);
      try {
        const resp = await fetch("https://dvf-api.data.gouv.fr/dvf/csv/?dep=" + encodeURIComponent(dep));
        return new Response(await resp.text(), {
          status: resp.status,
          headers: { ...CORS_BASE, "Content-Type": "text/csv" },
        });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }

    // ========== BDF ==========
    if (url.pathname.startsWith("/bdf/")) {
      const bdfPath = url.pathname.replace("/bdf/", "");
      const bdfUrl = "https://webstat.banque-france.fr/api/explore/v2.1/catalog/datasets/" + bdfPath + (url.search || "");
      try {
        const resp = await fetch(bdfUrl, {
          headers: { "Authorization": "Apikey " + env.FRENCH_API, "Accept": "application/json" },
        });
        return new Response(await resp.text(), { status: resp.status, headers: JSON_H });
      } catch (e) {
        return json({ error: "BdF API error: " + e.message }, 502);
      }
    }

    // ========== CLAUDE PROXY (fallback POST) ==========
    if (request.method === "POST") {
      const body = await request.text();
      if (!body) return json({ error: "No body" }, 400);
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body,
      });
      return new Response(await resp.text(), { headers: JSON_H });
    }

    return new Response("Proxy OK", { status: 200, headers: CORS_BASE });
  },
};
