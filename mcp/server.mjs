#!/usr/bin/env node
// Octopus MCP server — lets other AI assistants send WhatsApp messages
// through Octopus (the wa-assistant bot) and look up its contacts/groups.
//
// It never touches WhatsApp itself: a send is queued in the `outbox` table
// of the bot's SQLite DB (../data/agent.db); the bot process — the only
// holder of the WhatsApp socket — performs the send through its normal
// path and records the outcome on the row, which this server polls.
//
// Transports: Streamable HTTP (POST /mcp, GET /health) and stdio (--stdio).
// Auth: when MCP_TOKEN is set (mcp/.env), HTTP calls need
// `Authorization: Bearer <token>`. stdio is local-only by nature.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { timingSafeEqual } from 'node:crypto';

const DIR = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(DIR, '..', 'data', 'agent.db');

// Tiny .env loader (no dependencies).
const envFile = join(DIR, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0 && !process.env[t.slice(0, i).trim()]) {
      process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
}

const PORT = Number(process.env.MCP_PORT || 8765);
const HOST = process.env.MCP_HOST || '0.0.0.0';
const TOKEN = process.env.MCP_TOKEN || '';

if (!existsSync(DB_PATH)) {
  console.error(`octopus-mcp: bot database not found at ${DB_PATH}`);
  process.exit(1);
}
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000;');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getKv(key) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key);
  if (!row) return null;
  try { return JSON.parse(row.v); } catch { return null; }
}

function allGroupsParsed() {
  return db.prepare('SELECT jid, data FROM groups').all()
    .map((r) => { try { return { jid: r.jid, ...JSON.parse(r.data) }; } catch { return null; } })
    .filter(Boolean);
}

// ---------- tools ----------

function toolStatus() {
  const hb = getKv('mcpStatus');
  const fresh = Boolean(hb && Date.now() - hb.ts < 30000);
  const one = (sql) => db.prepare(sql).get().n;
  return {
    assistant: 'Octopus',
    connected: Boolean(fresh && hb.connected),
    whatsapp_number: hb?.botJid ? String(hb.botJid).split('@')[0].split(':')[0] : null,
    heartbeat_age_seconds: hb ? Math.round((Date.now() - hb.ts) / 1000) : null,
    contacts: one('SELECT COUNT(*) AS n FROM contacts'),
    groups: one('SELECT COUNT(*) AS n FROM groups'),
    outbox_pending: one("SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending','sending')"),
  };
}

function toolListContacts(query) {
  const pn = new Set();
  const lid = new Set();
  for (const g of allGroupsParsed()) {
    for (const m of g.members || []) {
      if (m.pn) pn.add(m.pn);
      if (m.lid) lid.add(m.lid);
    }
  }
  const byName = new Map();
  for (const r of db.prepare("SELECT id, name FROM contacts WHERE name != ''").all()) {
    const key = r.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, { name: r.name, ids: [] });
    byName.get(key).ids.push(r.id);
  }
  let people = [...byName.values()].map((p) => {
    const phone = p.ids.find((i) => pn.has(i)) || p.ids.find((i) => i.length < 14);
    const lidId = p.ids.find((i) => lid.has(i)) || p.ids.find((i) => i.length >= 14);
    return {
      name: p.name,
      jid: phone ? `${phone}@s.whatsapp.net` : `${lidId}@lid`,
      number: phone || null,
    };
  });
  if (query) {
    const q = String(query).toLowerCase();
    people = people.filter((p) => p.name.toLowerCase().includes(q));
  }
  people.sort((a, b) => a.name.localeCompare(b.name));
  return { count: people.length, contacts: people.slice(0, 200) };
}

function toolListGroups() {
  const groups = allGroupsParsed()
    .map((g) => ({ name: g.name || '', jid: g.jid, members: (g.members || []).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { count: groups.length, groups };
}

const DIRECT_URL = process.env.OCTOPUS_DIRECT_URL || 'http://127.0.0.1:8766/send';

async function toolSendMessage(args) {
  const target = String(args.target || '').trim();
  const text = String(args.text || '').trim();
  const voice = args.voice === true;
  if (!target || !text) throw new Error('target and text are required');
  if (text.length > 4000) throw new Error('text too long (max 4000 chars)');
  // Fire-and-forget mode (wait: false): queue the send and return at once
  // instead of waiting for WhatsApp to accept it. The bot drains the
  // queue within ~1s; delivery itself is not confirmed to the caller.
  if (args.wait === false) {
    const info = db.prepare(
      "INSERT INTO outbox (target, text, voice, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    ).run(target, text, voice ? 1 : 0, Date.now());
    return { ok: true, queued: true, outbox_id: Number(info.lastInsertRowid), via: 'queue' };
  }
  // Fast path: the bot performs the send synchronously on its direct
  // endpoint — no queue wait. A 503 (bot disconnected) or an unreachable
  // endpoint falls through to the durable outbox queue below.
  try {
    const r = await fetch(DIRECT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify({ target, text, voice }),
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 200) {
      return { ...(await r.json()), via: 'direct' };
    }
    if (r.status !== 503) {
      const out = await r.json().catch(() => null);
      return { ok: false, error: out?.error || `direct endpoint HTTP ${r.status}` };
    }
  } catch { /* endpoint unreachable — use the queue */ }
  const info = db.prepare(
    "INSERT INTO outbox (target, text, voice, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
  ).run(target, text, voice ? 1 : 0, Date.now());
  const id = Number(info.lastInsertRowid);
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const row = db.prepare('SELECT status, jid, name, error FROM outbox WHERE id = ?').get(id);
    if (!row) throw new Error('outbox row vanished');
    if (row.status === 'sent') {
      return { ok: true, to: row.name, jid: row.jid, as: voice ? 'voice note' : 'text', outbox_id: id, via: 'queue' };
    }
    if (row.status === 'failed') {
      return { ok: false, error: row.error || 'send failed', outbox_id: id, via: 'queue' };
    }
    await sleep(100);
  }
  return { ok: false, error: 'queued, but Octopus did not process it within 25s (is the bot connected?)', outbox_id: id, via: 'queue' };
}

const TOOLS = [
  {
    name: 'octopus_status',
    description: 'Check whether Octopus (the WhatsApp assistant) is connected, and on which WhatsApp number.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'octopus_list_contacts',
    description: "List Octopus's saved WhatsApp contacts (name + number), optionally filtered by a name substring. Use this to find the exact name/number before sending.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional name substring filter.' } },
    },
  },
  {
    name: 'octopus_list_groups',
    description: "List the WhatsApp groups Octopus knows (name + member count).",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'octopus_send_message',
    description: "Send a WhatsApp message AS Octopus (from its number). Target is a contact name, a group name, or a phone number with country code (e.g. 923001234567). The message is delivered exactly as written — compose it fully yourself. By default the call waits until WhatsApp accepts the message and returns the confirmed outcome (an ambiguous name returns the matching candidates instead). Set wait=false for fire-and-forget: the call returns as soon as the send is queued (Octopus sends within ~1s) without delivery confirmation — use it when response speed matters more than confirmation.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Contact name, group name, or phone number with country code.' },
        text: { type: 'string', description: 'The exact message text to send.' },
        voice: { type: 'boolean', description: 'Optional: true sends it as a voice note instead of text. Default false.' },
        wait: { type: 'boolean', description: 'Optional: false = fire-and-forget, returns immediately after queueing without delivery confirmation. Default true.' },
      },
      required: ['target', 'text'],
    },
  },
];

async function callTool(name, args) {
  let res;
  switch (name) {
    case 'octopus_status': res = toolStatus(); break;
    case 'octopus_list_contacts': res = toolListContacts(args.query); break;
    case 'octopus_list_groups': res = toolListGroups(); break;
    case 'octopus_send_message': res = await toolSendMessage(args); break;
    default: throw new Error(`unknown tool ${name}`);
  }
  return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
}

// ---------- JSON-RPC ----------

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handleRpc(msg) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid request');
  }
  const { id, method } = msg;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: msg.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'octopus-mcp', version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call':
      try {
        return rpcResult(id, await callTool(msg.params?.name, msg.params?.arguments || {}));
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }],
          isError: true,
        });
      }
    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------- transports ----------

if (process.argv.includes('--stdio')) {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try { msg = JSON.parse(t); } catch { continue; }
    const out = await handleRpc(msg);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  }
} else {
  const sendJson = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/health') {
      sendJson(res, 200, { ok: true, service: 'octopus-mcp' });
      return;
    }
    if (url.pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (TOKEN) {
      const auth = req.headers.authorization || '';
      const expected = `Bearer ${TOKEN}`;
      const ok = auth.length === expected.length
        && timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
      if (!ok) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('end', async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
        return;
      }
      const msgs = Array.isArray(parsed) ? parsed : [parsed];
      const responses = [];
      for (const m of msgs) {
        const r = await handleRpc(m);
        if (r) responses.push(r);
      }
      if (!responses.length) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'octopus-stateless' });
      res.end(JSON.stringify(Array.isArray(parsed) ? responses : responses[0]));
    });
  });
  // Long keep-alive: MCP clients that pool connections (the common case)
  // skip a fresh tunnel handshake on every call.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.listen(PORT, HOST, () => {
    console.error(`octopus-mcp listening on http://${HOST}:${PORT}/mcp (db: ${DB_PATH}, auth: ${TOKEN ? 'on' : 'OFF'})`);
  });
}
