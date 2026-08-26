const enc = new TextEncoder();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const now = () => Date.now();

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeCode(value) {
  return String(value || "").trim().toUpperCase();
}

function validCode(code) {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

function randomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const byte of bytes) raw += chars[byte % chars.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function adminToken(req) {
  const header = req.headers.get("authorization") || "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  return bearer || req.headers.get("x-admin-token") || "";
}

function isAdmin(req, env) {
  return Boolean(env.ADMIN_TOKEN && adminToken(req) === env.ADMIN_TOKEN);
}

async function createSession(env, codeId, deviceId, expiresAt) {
  const rawToken = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const sessionHash = await sha256(rawToken);
  const timestamp = now();

  await env.DB.prepare(`
    INSERT INTO sessions
      (code_id, device_id, session_hash, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)
    .bind(codeId, deviceId, sessionHash, timestamp, expiresAt, timestamp)
    .run();

  return rawToken;
}

async function verify(req, env) {
  const body = await req.json().catch(() => null);
  if (!body) return json({ ok: false, error: "请求数据无效。" }, 400);

  const code = normalizeCode(body.code);
  const testSlug = String(body.testSlug || "").trim();
  const deviceToken = String(body.deviceToken || body.deviceId || "").trim();

  if (!validCode(code)) return json({ ok: false, error: "验证码格式不正确。" }, 400);
  if (!testSlug) return json({ ok: false, error: "缺少测试信息。" }, 400);
  if (!deviceToken || deviceToken.length > 200) {
    return json({ ok: false, error: "设备信息无效。" }, 400);
  }

  const test = await env.DB.prepare(`
    SELECT slug, title, subtitle, description
    FROM tests
    WHERE slug = ? AND enabled = 1
    LIMIT 1
  `).bind(testSlug).first();

  if (!test) return json({ ok: false, error: "测试不存在或暂未开放。" }, 404);

  const codeHash = await sha256(code);
  const codeRow = await env.DB.prepare(`
    SELECT id, code_preview, test_slug, status, created_at, activated_at, expires_at, max_devices
    FROM codes
    WHERE code_hash = ? AND test_slug = ?
    LIMIT 1
  `).bind(codeHash, testSlug).first();

  if (!codeRow) {
    return json({ ok: false, error: "验证码无效，或该验证码不属于当前测试。" }, 401);
  }

  if (codeRow.status === "revoked") {
    return json({ ok: false, error: "该验证码已被作废。" }, 403);
  }

  const current = now();
  let expiresAt = Number(codeRow.expires_at || 0);

  if (codeRow.activated_at && (!expiresAt || current > expiresAt)) {
    await env.DB.prepare(`UPDATE codes SET status = 'expired' WHERE id = ?`).bind(codeRow.id).run();
    return json({ ok: false, error: "该验证码已经过期。" }, 403);
  }

  const deviceHash = await sha256(deviceToken);
  const existingDevice = await env.DB.prepare(`
    SELECT id
    FROM devices
    WHERE code_id = ? AND device_token_hash = ?
    LIMIT 1
  `).bind(codeRow.id, deviceHash).first();

  if (!codeRow.activated_at) {
    expiresAt = current + 48 * 60 * 60 * 1000;
    await env.DB.prepare(`
      UPDATE codes
      SET activated_at = ?, expires_at = ?, status = 'active'
      WHERE id = ?
    `).bind(current, expiresAt, codeRow.id).run();
  }

  let deviceId;

  if (existingDevice) {
    deviceId = Number(existingDevice.id);
    await env.DB.prepare(`UPDATE devices SET last_seen_at = ?, user_agent = ? WHERE id = ?`)
      .bind(current, req.headers.get("user-agent") || "", deviceId)
      .run();
  } else {
    const deviceCount = await env.DB.prepare(`
      SELECT COUNT(*) AS count
      FROM devices
      WHERE code_id = ?
    `).bind(codeRow.id).first();

    if (Number(deviceCount?.count || 0) >= Number(codeRow.max_devices || 5)) {
      return json({ ok: false, error: `该验证码已经达到 ${codeRow.max_devices || 5} 台设备的使用上限。` }, 403);
    }

    const deviceResult = await env.DB.prepare(`
      INSERT INTO devices
        (code_id, device_token_hash, user_agent, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      codeRow.id,
      deviceHash,
      req.headers.get("user-agent") || "",
      current,
      current
    ).run();

    deviceId = Number(deviceResult.meta.last_row_id);
  }

  const token = await createSession(env, codeRow.id, deviceId, expiresAt);

  return json({
    ok: true,
    token,
    test: {
      slug: test.slug,
      title: test.title,
      subtitle: test.subtitle || "",
      description: test.description || "",
    },
    expiresAt,
  });
}

async function authenticateSession(req, env, expectedTestSlug = null) {
  const auth = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!auth) return null;

  const sessionHash = await sha256(auth);
  const session = await env.DB.prepare(`
    SELECT
      s.id,
      s.code_id,
      s.device_id,
      s.expires_at,
      c.test_slug
    FROM sessions s
    JOIN codes c ON c.id = s.code_id
    WHERE s.session_hash = ?
      AND s.expires_at > ?
      AND c.status != 'revoked'
    LIMIT 1
  `).bind(sessionHash, now()).first();

  if (!session) return null;
  if (expectedTestSlug && session.test_slug !== expectedTestSlug) return null;

  await env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`)
    .bind(now(), session.id)
    .run();

  return session;
}

async function adminApi(req, env, path) {
  if (!isAdmin(req, env)) return json({ ok: false, error: "管理员权限不足。" }, 401);

  if (req.method === "GET" && path === "/api/admin/tests") {
    const result = await env.DB.prepare(`
      SELECT id, slug, title, subtitle, description, enabled, sort_order
      FROM tests ORDER BY sort_order ASC, id ASC
    `).all();
    return json({ ok: true, tests: result.results || [] });
  }

  if (req.method === "POST" && path === "/api/admin/codes") {
    const body = await req.json().catch(() => ({}));
    const testSlug = String(body.testSlug || "").trim();
    let quantity = Number(body.quantity ?? body.count ?? 1);
    quantity = Number.isInteger(quantity) ? Math.max(1, Math.min(quantity, 100)) : 1;
    const note = String(body.note || "").trim().slice(0, 200);

    const test = await env.DB.prepare(`
      SELECT slug, title FROM tests WHERE slug = ? AND enabled = 1 LIMIT 1
    `).bind(testSlug).first();
    if (!test) return json({ ok: false, error: "请选择一个已开放的测试。" }, 400);

    const created = [];
    for (let i = 0; i < quantity; i++) {
      let code = "";
      let hash = "";
      for (;;) {
        code = randomCode();
        hash = await sha256(code);
        const exists = await env.DB.prepare(`SELECT id FROM codes WHERE code_hash = ? LIMIT 1`).bind(hash).first();
        if (!exists) break;
      }

      const result = await env.DB.prepare(`
        INSERT INTO codes
          (code_hash, code_preview, status, created_at, max_devices, note, test_slug)
        VALUES (?, ?, 'unused', ?, 5, ?, ?)
      `).bind(hash, code, now(), note, testSlug).run();

      created.push({
        id: Number(result.meta.last_row_id),
        code,
        testSlug,
        testTitle: test.title,
      });
    }

    return json({ ok: true, codes: created });
  }

  if (req.method === "GET" && path === "/api/admin/codes") {
    const result = await env.DB.prepare(`
      SELECT
        c.id, c.code_preview, c.test_slug, c.status, c.created_at,
        c.activated_at, c.expires_at, c.max_devices, c.note,
        t.title AS test_title,
        (SELECT COUNT(*) FROM devices d WHERE d.code_id = c.id) AS device_count
      FROM codes c
      LEFT JOIN tests t ON t.slug = c.test_slug
      ORDER BY c.id DESC
    `).all();
    return json({ ok: true, codes: result.results || [] });
  }

  const devicesMatch = path.match(/^\/api\/admin\/codes\/(\d+)\/devices$/);
  if (req.method === "GET" && devicesMatch) {
    const result = await env.DB.prepare(`
      SELECT id, user_agent, created_at, last_seen_at
      FROM devices WHERE code_id = ? ORDER BY id ASC
    `).bind(Number(devicesMatch[1])).all();
    return json({ ok: true, devices: result.results || [] });
  }

  const revokeMatch = path.match(/^\/api\/admin\/codes\/(\d+)\/revoke$/);
  if (req.method === "POST" && revokeMatch) {
    await env.DB.prepare(`UPDATE codes SET status = 'revoked' WHERE id = ?`).bind(Number(revokeMatch[1])).run();
    return json({ ok: true });
  }

  const extendMatch = path.match(/^\/api\/admin\/codes\/(\d+)\/extend$/);
  if (req.method === "POST" && extendMatch) {
    const body = await req.json().catch(() => ({}));
    let hours = Number(body.hours || 48);
    hours = Math.max(1, Math.min(hours, 720));
    const row = await env.DB.prepare(`SELECT activated_at, expires_at, status FROM codes WHERE id = ?`).bind(Number(extendMatch[1])).first();
    if (!row) return json({ ok: false, error: "验证码不存在。" }, 404);
    const base = Math.max(now(), Number(row.expires_at || now()));
    const expiresAt = base + hours * 60 * 60 * 1000;
    await env.DB.prepare(`UPDATE codes SET expires_at = ?, status = 'active' WHERE id = ?`).bind(expiresAt, Number(extendMatch[1])).run();
    return json({ ok: true, expiresAt });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

async function api(req, env, path) {
  if (req.method === "POST" && path === "/api/verify") return verify(req, env);

  if (req.method === "GET" && path === "/api/me") {
    const session = await authenticateSession(req, env);
    if (!session) return json({ ok: false, error: "授权已失效，请重新输入验证码。" }, 401);

    const test = await env.DB.prepare(`
      SELECT slug, title, subtitle, description FROM tests WHERE slug = ? LIMIT 1
    `).bind(session.test_slug).first();

    return json({
      ok: true,
      test,
      expiresAt: Number(session.expires_at),
      testSlug: session.test_slug,
    });
  }

  if (path.startsWith("/api/admin/")) return adminApi(req, env, path);

  return json({ ok: false, error: "Not found" }, 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return api(req, env, url.pathname);
    return env.ASSETS.fetch(req);
  },
};
