const enc = new TextEncoder();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const now = () => Date.now();

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    enc.encode(value)
  );

  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function validCode(code) {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code);
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);

  let result = "";

  for (const byte of bytes) {
    result += chars[byte % chars.length];
  }

  return result.slice(0, 4) + "-" + result.slice(4);
}

async function createSession(env, codeId, deviceId, expiresAt) {
  const rawToken = crypto.randomUUID() + "-" + crypto.randomUUID();
  const tokenHash = await sha256(rawToken);

  await env.DB.prepare(`
    INSERT INTO sessions
      (code_id, device_id, token_hash, expires_at)
    VALUES
      (?, ?, ?, ?)
  `)
    .bind(codeId, deviceId, tokenHash, expiresAt)
    .run();

  return rawToken;
}

async function verify(req, env) {
  const body = await req.json().catch(() => null);

  if (!body) {
    return json(
      { ok: false, error: "请求数据无效。" },
      400
    );
  }

  const code = normalizeCode(body.code);
  const testSlug = String(body.testSlug || "").trim();
  const deviceId = String(body.deviceId || "").trim();

  if (!validCode(code)) {
    return json(
      {
        ok: false,
        error: "验证码格式不正确。"
      },
      400
    );
  }

  if (!testSlug) {
    return json(
      {
        ok: false,
        error: "缺少测试信息。"
      },
      400
    );
  }

  if (!deviceId || deviceId.length > 200) {
    return json(
      {
        ok: false,
        error: "设备信息无效。"
      },
      400
    );
  }

  /*
   * 1. 检查测试是否存在
   */
  const test = await env.DB.prepare(`
    SELECT slug, title, description
    FROM tests
    WHERE slug = ?
      AND active = 1
    LIMIT 1
  `)
    .bind(testSlug)
    .first();

  if (!test) {
    return json(
      {
        ok: false,
        error: "测试不存在或暂未开放。"
      },
      404
    );
  }

  /*
   * 2. 检查验证码
   *
   * 最关键的一步：
   *
   * codes.test_slug 必须等于当前测试。
   */
  const codeRow = await env.DB.prepare(`
    SELECT
      id,
      code,
      test_slug,
      activated_at,
      expires_at
    FROM codes
    WHERE code = ?
      AND test_slug = ?
    LIMIT 1
  `)
    .bind(code, testSlug)
    .first();

  if (!codeRow) {
    return json(
      {
        ok: false,
        error: "验证码无效，或该验证码不属于当前测试。"
      },
      401
    );
  }

  const current = now();

  /*
   * 3. 如果已经激活
   */
  if (codeRow.activated_at) {
    const expiresAt = Number(codeRow.expires_at || 0);

    if (!expiresAt || current > expiresAt) {
      return json(
        {
          ok: false,
          error: "该验证码已经过期。"
        },
        403
      );
    }
  }

  /*
   * 4. 检查这个设备是否已经授权
   */
  const existingDevice = await env.DB.prepare(`
    SELECT id, expires_at
    FROM sessions
    WHERE code_id = ?
      AND device_id = ?
      AND expires_at > ?
    LIMIT 1
  `)
    .bind(codeRow.id, deviceId, current)
    .first();

  if (existingDevice) {
    const token = await createSession(
      env,
      codeRow.id,
      deviceId,
      Number(existingDevice.expires_at)
    );

    return json({
      ok: true,
      token,
      test: {
        slug: test.slug,
        title: test.title,
        description: test.description
      },
      expiresAt: Number(existingDevice.expires_at)
    });
  }

  /*
   * 5. 如果是新设备，检查设备数量
   */
  const deviceCount = await env.DB.prepare(`
    SELECT COUNT(DISTINCT device_id) AS count
    FROM sessions
    WHERE code_id = ?
      AND expires_at > ?
  `)
    .bind(codeRow.id, current)
    .first();

  const count = Number(deviceCount?.count || 0);

  if (count >= 5) {
    return json(
      {
        ok: false,
        error: "该验证码已经达到 5 台设备的使用上限。"
      },
      403
    );
  }

  /*
   * 6. 第一次使用验证码
   *
   * 从第一次验证成功开始计算 48 小时。
   */
  let expiresAt;

  if (!codeRow.activated_at) {
    expiresAt = current + 48 * 60 * 60 * 1000;

    await env.DB.prepare(`
      UPDATE codes
      SET
        activated_at = ?,
        expires_at = ?
      WHERE id = ?
    `)
      .bind(
        new Date(current).toISOString(),
        expiresAt,
        codeRow.id
      )
      .run();
  } else {
    expiresAt = Number(codeRow.expires_at);
  }

  /*
   * 7. 创建设备 session
   */
  const token = await createSession(
    env,
    codeRow.id,
    deviceId,
    expiresAt
  );

  return json({
    ok: true,
    token,
    test: {
      slug: test.slug,
      title: test.title,
      description: test.description
    },
    expiresAt
  });
}


/* =========================
   Session 验证
========================= */

async function authenticateSession(req, env) {
  const auth = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();

  if (!auth) {
    return null;
  }

  const tokenHash = await sha256(auth);

  const session = await env.DB.prepare(`
    SELECT
      s.id,
      s.code_id,
      s.device_id,
      s.expires_at,
      c.test_slug
    FROM sessions s
    JOIN codes c
      ON c.id = s.code_id
    WHERE s.token_hash = ?
      AND s.expires_at > ?
    LIMIT 1
  `)
    .bind(tokenHash, now())
    .first();

  return session || null;
}


/* =========================
   管理员权限
========================= */

function isAdmin(req, env) {
  const token = req.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();

  return Boolean(
    token &&
    env.ADMIN_TOKEN &&
    token === env.ADMIN_TOKEN
  );
}


/* =========================
   API
========================= */

async function api(req, env, path) {

  /*
   * 用户验证验证码
   */
  if (
    req.method === "POST" &&
    path === "/api/verify"
  ) {
    return verify(req, env);
  }


  /*
   * 查询当前登录 session
   */
  if (
    req.method === "GET" &&
    path === "/api/me"
  ) {
    const session = await authenticateSession(req, env);

    if (!session) {
      return json(
        {
          ok: false,
          error: "授权已失效，请重新输入验证码。"
        },
        401
      );
    }

    const test = await env.DB.prepare(`
      SELECT slug, title, description
      FROM tests
      WHERE slug = ?
      LIMIT 1
    `)
      .bind(session.test_slug)
      .first();

    return json({
      ok: true,
      test,
      expiresAt: Number(session.expires_at)
    });
  }


  /*
   * =========================
   * 管理员 API
   * =========================
   */

  if (path.startsWith("/api/admin/")) {

    if (!isAdmin(req, env)) {
      return json(
        {
          ok: false,
          error: "管理员权限不足。"
        },
        401
      );
    }


    /*
     * 获取测试列表
     */
    if (
      req.method === "GET" &&
      path === "/api/admin/tests"
    ) {
      const result = await env.DB.prepare(`
        SELECT
          id,
          slug,
          title,
          description,
          active
        FROM tests
        ORDER BY id ASC
      `).all();

      return json({
        ok: true,
        tests: result.results || []
      });
    }


    /*
     * 生成验证码
     *
     * POST /api/admin/codes
     *
     * {
     *   "testSlug": "stress-map",
     *   "count": 10
     * }
     */
    if (
      req.method === "POST" &&
      path === "/api/admin/codes"
    ) {

      const body = await req.json().catch(() => null);

      const testSlug = String(
        body?.testSlug || ""
      ).trim();

      let count = Number(body?.count || 1);

      if (!Number.isInteger(count)) {
        count = 1;
      }

      count = Math.max(1, Math.min(count, 100));

      const test = await env.DB.prepare(`
        SELECT slug, title
        FROM tests
        WHERE slug = ?
          AND active = 1
        LIMIT 1
      `)
        .bind(testSlug)
        .first();

      if (!test) {
        return json(
          {
            ok: false,
            error: "测试不存在或未开放。"
          },
          400
        );
      }

      const created = [];

      for (let i = 0; i < count; i++) {

        let code;

        /*
         * 防止极小概率的验证码重复
         */
        for (;;) {
          code = randomCode();

          const exists = await env.DB.prepare(`
            SELECT id
            FROM codes
            WHERE code = ?
            LIMIT 1
          `)
            .bind(code)
            .first();

          if (!exists) break;
        }

        const result = await env.DB.prepare(`
          INSERT INTO codes
            (code, test_slug)
          VALUES
            (?, ?)
        `)
          .bind(code, testSlug)
          .run();

        created.push({
          id: result.meta.last_row_id,
          code,
          testSlug,
          testTitle: test.title
        });
      }

      return json({
        ok: true,
        codes: created
      });
    }


    /*
     * 查看验证码
     */
    if (
      req.method === "GET" &&
      path === "/api/admin/codes"
    ) {

      const result = await env.DB.prepare(`
        SELECT
          c.id,
          c.code,
          c.test_slug,
          c.activated_at,
          c.expires_at,
          t.title AS test_title,

          (
            SELECT COUNT(DISTINCT s.device_id)
            FROM sessions s
            WHERE s.code_id = c.id
              AND s.expires_at > ?
          ) AS device_count

        FROM codes c

        LEFT JOIN tests t
          ON t.slug = c.test_slug

        ORDER BY c.id DESC
      `)
        .bind(now())
        .all();

      return json({
        ok: true,
        codes: result.results || []
      });
    }


    /*
     * 查看某个验证码的设备
     */
    const deviceMatch = path.match(
      /^\/api\/admin\/codes\/(\d+)\/devices$/
    );

    if (
      req.method === "GET" &&
      deviceMatch
    ) {

      const codeId = Number(deviceMatch[1]);

      const result = await env.DB.prepare(`
        SELECT
          id,
          device_id,
          expires_at
        FROM sessions
        WHERE code_id = ?
        ORDER BY id ASC
      `)
        .bind(codeId)
        .all();

      return json({
        ok: true,
        devices: result.results || []
      });
    }
  }


  return json(
    {
      ok: false,
      error: "Not found"
    },
    404
  );
}


/* =========================
   Worker
========================= */

export default {
  async fetch(req, env) {

    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      return api(req, env, url.pathname);
    }

    /*
     * API 之外全部交给静态资源
     */
    return env.ASSETS.fetch(req);
  }
};
