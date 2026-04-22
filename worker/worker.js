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
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Auth-Token",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
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

// ====== Routes BORDEREAUX ======
async function handleBordereaux(request, env, url) {
  const auth = requireAuth(request, env);
  if (!auth.ok) return auth.err;
  const user = auth.user;
  const ip = getIp(request);

  const sub = url.pathname.replace(/^\/bordereaux\/?/, "");
  const method = request.method;

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
