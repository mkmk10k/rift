/**
 * Rift Diagnostics Worker
 *
 * Receives crash/error diagnostics from the Rift desktop app and stores them
 * in KV so Mikko can fetch and triage later.
 *
 * Endpoints:
 *   POST /report          – submit diagnostics (public, rate-limited)
 *   GET  /reports?key=KEY – list all reports (admin)
 *   GET  /report/:id?key=KEY – fetch one report (admin)
 *   DELETE /report/:id?key=KEY – delete a report (admin)
 */

interface Env {
  DIAGNOSTICS_KV: KVNamespace;
  ADMIN_KEY: string;
}

interface DiagnosticsPayload {
  diagnostics: string;
  appVersion?: string;
  osVersion?: string;
  arch?: string;
  error?: string;
  timestamp?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function isAdmin(url: URL, env: Env): boolean {
  return url.searchParams.get('key') === env.ADMIN_KEY;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // POST /report — submit diagnostics
    if (request.method === 'POST' && url.pathname === '/report') {
      return handleSubmit(request, env);
    }

    // GET /reports — list all (admin)
    if (request.method === 'GET' && url.pathname === '/reports') {
      if (!isAdmin(url, env)) return json({ error: 'Unauthorized' }, 401);
      return handleList(env);
    }

    // GET /report/:id — fetch one (admin)
    const getMatch = url.pathname.match(/^\/report\/(.+)$/);
    if (request.method === 'GET' && getMatch) {
      if (!isAdmin(url, env)) return json({ error: 'Unauthorized' }, 401);
      return handleGet(getMatch[1], env);
    }

    // DELETE /report/:id — delete (admin)
    if (request.method === 'DELETE' && getMatch) {
      if (!isAdmin(url, env)) return json({ error: 'Unauthorized' }, 401);
      return handleDelete(getMatch[1], env);
    }

    return json({ error: 'Not found' }, 404);
  },
};

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  // Simple rate limit: 10 reports per IP per hour
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitKey = `ratelimit:${ip}`;
  const currentCount = parseInt((await env.DIAGNOSTICS_KV.get(rateLimitKey)) || '0');
  if (currentCount >= 10) {
    return json({ error: 'Rate limited. Try again later.' }, 429);
  }
  await env.DIAGNOSTICS_KV.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 3600 });

  let body: DiagnosticsPayload;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body.diagnostics || typeof body.diagnostics !== 'string') {
    return json({ error: 'Missing "diagnostics" field' }, 400);
  }

  const now = new Date();
  const id = `${now.toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID().slice(0, 8)}`;
  const key = `report:${id}`;

  const report = {
    id,
    diagnostics: body.diagnostics,
    appVersion: body.appVersion || 'unknown',
    osVersion: body.osVersion || 'unknown',
    arch: body.arch || 'unknown',
    error: body.error || '',
    ip,
    submittedAt: now.toISOString(),
  };

  // Store for 90 days
  await env.DIAGNOSTICS_KV.put(key, JSON.stringify(report), { expirationTtl: 90 * 86400 });

  return json({ ok: true, id, message: 'Report received. Mikko will investigate.' });
}

async function handleList(env: Env): Promise<Response> {
  const list = await env.DIAGNOSTICS_KV.list({ prefix: 'report:' });
  const reports = [];

  for (const key of list.keys) {
    const raw = await env.DIAGNOSTICS_KV.get(key.name);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        reports.push({
          id: parsed.id,
          appVersion: parsed.appVersion,
          osVersion: parsed.osVersion,
          error: parsed.error,
          submittedAt: parsed.submittedAt,
          preview: parsed.diagnostics.slice(0, 200),
        });
      } catch { /* skip corrupt entries */ }
    }
  }

  return json({ count: reports.length, reports });
}

async function handleGet(id: string, env: Env): Promise<Response> {
  const raw = await env.DIAGNOSTICS_KV.get(`report:${id}`);
  if (!raw) return json({ error: 'Report not found' }, 404);

  try {
    return json(JSON.parse(raw));
  } catch {
    return json({ error: 'Corrupt report data' }, 500);
  }
}

async function handleDelete(id: string, env: Env): Promise<Response> {
  await env.DIAGNOSTICS_KV.delete(`report:${id}`);
  return json({ ok: true, deleted: id });
}
