#!/usr/bin/env node
'use strict';
// Agent Dashboard server: a read-only observer of Claude Code activity on this machine.
//   node server/index.js [--port 4317] [--root ~/.claude]
// Binds to 127.0.0.1 only. Never writes to --root.

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Ingest, nodeDetail } = require('./ingest');
const { readRegistry, discoverDefinitions } = require('./sources');
const { clip } = require('./util');

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
const PORT = Number(opt('port', process.env.PORT || 4317));
const ROOT = path.resolve(opt('root', path.join(os.homedir(), '.claude')).replace(/^~(?=$|\/)/, os.homedir()));
const IS_REAL_ROOT = ROOT === path.join(os.homedir(), '.claude');
const PUBLIC = path.join(__dirname, '..', 'public');
const BOOT_ID = crypto.randomBytes(4).toString('hex');
const STARTED = Date.now();

// ---------------- SSE hub ----------------
let seq = 0;
const ring = [];
const clients = new Set();
function publish(event, data) {
  const msg = { seq: ++seq, event, data: JSON.stringify(data) };
  ring.push(msg);
  if (ring.length > 4000) ring.shift();
  for (const res of clients) write(res, msg);
}
function write(res, msg) { res.write(`id: ${BOOT_ID}:${msg.seq}\nevent: ${msg.event}\ndata: ${msg.data}\n\n`); }

// ---------------- state ----------------
const dirtySessions = new Set();
const ingest = new Ingest({
  root: ROOT,
  emit: (type, p) => {
    if (type === 'node') publish('node', { sessionId: p.sessionId, node: pub(p.node) });
    else if (type === 'session') dirtySessions.add(p.sessionId);
  },
});
let registry = { ts: 0, ok: false, error: 'not read yet', entries: [] };
let regBySession = new Map();
let config = { definitions: [], searched: [] };
let bootDone = false;

function pub(n) {
  const { file, ref, refs, resultRef, promptRef, spawnRef, text, ...rest } = n;
  if (n.kind === 'turn') rest.preview = n.preview || '';
  else if (n.kind === 'prompt') rest.text = text;
  return rest;
}

function liveEntry(id) {
  const e = regBySession.get(id);
  return e && e.alive ? e : null;
}

function summarize(s) {
  const live = liveEntry(s.id);
  const state = live ? (live.status === 'busy' ? 'working' : 'idle') : 'historical';
  const first = s.promptIds.length ? s.nodes.get(s.promptIds[0]) : null;
  const subs = [];
  const openTools = [];
  let awaitingUser = null;
  for (const n of s.nodes.values()) {
    if (n.kind === 'subagent') subs.push({ id: n.id, agentId: n.agentId, agentType: n.agentType, description: n.description, status: n.status, ts: n.ts, endTs: n.endTs || null, lastActivityTs: n.lastActivityTs || null, scope: n.scope });
  }
  for (const id of s.open) {
    const n = s.nodes.get(id);
    if (!n || n.kind !== 'tool' || n.isAgentCall) continue;
    openTools.push({ id: n.id, name: n.name, input: n.input, ts: n.ts, scope: n.scope });
    if (n.needsUser && live) awaitingUser = { id: n.id, name: n.name, input: n.input, ts: n.ts };
  }
  openTools.sort((a, b) => b.ts - a.ts);
  subs.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const title = (live && live.name) || s.customTitle || (first ? clip(first.text, 90) : '(untitled session)');
  return {
    id: s.id,
    projectDir: s.projectDir,
    cwd: s.cwd || (live && live.cwd) || null,
    project: projectName(s, live),
    title,
    titleSource: live && live.name ? 'registry' : s.customTitle ? 'transcript title' : 'first prompt',
    state,
    live: live ? { pid: live.pid, status: live.status, statusUpdatedAt: live.statusUpdatedAt, startedAt: live.startedAt, version: live.version, entrypoint: live.entrypoint, kind: live.kind } : null,
    firstTs: s.firstTs, lastTs: s.lastTs, version: s.version, entrypoint: s.entrypoint, models: [...s.models],
    counts: { ...s.counts },
    lastAction: s.lastAction,
    subagents: subs.slice(0, 80),
    subagentTotal: subs.length,
    openTools: openTools.slice(0, 6),
    openToolTotal: openTools.length,
    awaitingUser,
    attention: s.attn.slice(-25),
    indexed: [...s.files.values()].every((f) => f.caught),
    transcript: [...s.files.values()].filter((f) => f.kind === 'main').map((f) => ({ bytes: f.size, error: f.error || null }))[0] || null,
  };
}

function projectName(s, live) {
  const cwd = s.cwd || (live && live.cwd);
  if (cwd) return cwd === os.homedir() ? '~' : cwd.replace(os.homedir(), '~');
  return s.projectDir.replace(/^-/, '/').replace(/-/g, '/');
}

function agentCatalog() {
  const used = new Map();
  for (const s of ingest.sessions.values()) {
    for (const n of s.nodes.values()) {
      if (n.kind !== 'subagent') continue;
      const t = n.agentType || '(unspecified)';
      const u = used.get(t) || { runs: 0, lastTs: 0 };
      u.runs++; u.lastTs = Math.max(u.lastTs, n.ts || 0);
      used.set(t, u);
    }
  }
  const items = [];
  const names = new Set();
  for (const d of config.definitions) {
    names.add(d.name);
    items.push({ name: d.name, source: d.scope, sourceLabel: d.scopeLabel, description: d.description, tools: d.tools, model: d.model, path: d.path, ...(used.get(d.name) || { runs: 0, lastTs: 0 }) });
  }
  for (const t of ingest.agentTypes.values()) {
    if (names.has(t.name)) continue;
    names.add(t.name);
    items.push({ name: t.name, source: 'builtin', sourceLabel: 'Built-in (listed to sessions by Claude Code)', description: t.description || '', tools: t.tools || null, model: null, listedInSessions: t.sessions.size, ...(used.get(t.name) || { runs: 0, lastTs: 0 }) });
  }
  for (const [name, u] of used) {
    if (names.has(name)) continue;
    items.push({ name, source: 'observed', sourceLabel: 'Seen in transcripts only (no definition found)', description: '', tools: null, model: null, ...u });
  }
  return { items, searched: config.searched };
}

function recentFeed(limitN = 200) {
  const cutoff = Date.now() - 3 * 24 * 3600 * 1000;
  const all = [];
  for (const s of ingest.sessions.values()) {
    for (const n of s.nodes.values()) {
      if (!n.ts || n.ts < cutoff) continue;
      if (n.kind === 'turn' && !n.preview) continue;
      all.push(n);
    }
  }
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, limitN).map(pub);
}

function snapshot() {
  const sessions = [...ingest.sessions.values()].map(summarize).sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  return {
    bootId: BOOT_ID, seq, now: Date.now(), startedAt: STARTED,
    root: ROOT, realRoot: IS_REAL_ROOT,
    health: {
      ...ingest.health, indexing: !bootDone,
      registry: { ok: registry.ok, error: registry.error, ts: registry.ts, entries: registry.entries.length, alive: registry.entries.filter((e) => e.alive).length },
    },
    sessions,
    catalog: agentCatalog(),
    feed: recentFeed(),
  };
}

// ---------------- watching loop ----------------
async function refreshRegistry() {
  const prev = new Map([...regBySession].map(([k, v]) => [k, `${v.alive}|${v.status}`]));
  registry = await readRegistry(ROOT);
  regBySession = new Map();
  for (const e of registry.entries) {
    const cur = regBySession.get(e.sessionId);
    if (!cur || (e.alive && !cur.alive)) regBySession.set(e.sessionId, e);
  }
  for (const [id, e] of regBySession) {
    if (prev.get(id) !== `${e.alive}|${e.status}`) dirtySessions.add(id);
  }
  for (const id of prev.keys()) if (!regBySession.has(id)) dirtySessions.add(id);
}

let lastDiscover = 0;
let lastConfig = 0;
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await refreshRegistry();
    if (bootDone) {
      const now = Date.now();
      if (now - lastDiscover > 2000) {
        lastDiscover = now;
        const fresh = ingest.register(await ingest.discover());
        for (const f of fresh) f.caught = true; // brand-new transcript: everything in it happened after we started watching
      }
      if (now - lastConfig > 30000) { lastConfig = now; await refreshConfig(); }
      for (const f of ingest.fileStates.values()) await ingest.drain(f).catch(() => { ingest.health.readErrors++; });
    }
    flushDirty();
  } finally { ticking = false; }
}

function flushDirty() {
  if (!dirtySessions.size) return;
  for (const id of dirtySessions) {
    const s = ingest.sessions.get(id);
    if (s) publish('session', summarize(s));
  }
  dirtySessions.clear();
}

async function refreshConfig() {
  const cwds = new Set();
  for (const s of ingest.sessions.values()) if (s.cwd) cwds.add(s.cwd);
  for (const e of registry.entries) if (e.cwd) cwds.add(e.cwd);
  config = await discoverDefinitions({ root: ROOT, cwds: [...cwds] });
}

async function initialIndex() {
  const found = await ingest.discover();
  ingest.register(found);
  const live = new Set(registry.entries.filter((e) => e.alive).map((e) => e.sessionId));
  const files = [...ingest.fileStates.values()];
  const stats = await Promise.all(files.map((f) => fsp.stat(f.path).then((s) => s.mtimeMs).catch(() => 0)));
  files.forEach((f, i) => { f.mtimeMs = stats[i]; });
  files.sort((a, b) => (live.has(b.sessionId) - live.has(a.sessionId)) || (b.mtimeMs - a.mtimeMs));
  ingest.health.indexTotal = files.length;
  ingest.health.indexing = true;
  // Main transcripts first so parent prompts exist before their subagents are attached.
  const ordered = [...files.filter((f) => f.kind === 'main'), ...files.filter((f) => f.kind === 'sub')];
  const t0 = Date.now();
  for (const f of ordered) {
    await ingest.drain(f).catch((e) => { ingest.health.readErrors++; console.error('index error', f.path, e.message); });
    ingest.health.indexed++;
  }
  await refreshConfig();
  bootDone = true;
  ingest.health.indexing = false;
  console.log(`indexed ${files.length} transcript files / ${ingest.sessions.size} sessions in ${Date.now() - t0} ms`);
  publish('reset', { reason: 'indexed' });
}

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

function hostAllowed(req) {
  const h = (req.headers.host || '').toLowerCase();
  const ok = [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`].includes(h);
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host.toLowerCase() !== h) return false; } catch { return false; } }
  return ok;
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) { res.writeHead(403); return res.end('forbidden host'); }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    if (p === '/api/state') return json(res, 200, snapshot());
    if (p === '/api/session') {
      const s = ingest.sessions.get(url.searchParams.get('id'));
      if (!s) return json(res, 404, { error: 'unknown session' });
      const want = url.searchParams.get('all') ? Infinity : Math.max(1, Number(url.searchParams.get('prompts')) || 30);
      const keep = new Set(s.promptIds.slice(Math.max(0, s.promptIds.length - want)));
      const nodes = [];
      for (const n of s.nodes.values()) if (n.promptId == null || keep.has(n.promptId)) nodes.push(pub(n));
      nodes.sort((a, b) => a.ord - b.ord);
      return json(res, 200, { summary: summarize(s), nodes, promptTotal: s.promptIds.length, promptsIncluded: keep.size, seq });
    }
    if (p === '/api/node') {
      const s = ingest.sessions.get(url.searchParams.get('session'));
      const n = s && s.nodes.get(url.searchParams.get('id'));
      if (!n) return json(res, 404, { error: 'unknown node' });
      return json(res, 200, await nodeDetail(s, n));
    }
    if (p === '/api/stream') return stream(req, res);
    // static
    let rel = p === '/' ? '/index.html' : p;
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
    const data = await fsp.readFile(file).catch(() => null);
    if (!data) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) {
    console.error('request error', e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' }); else res.end();
  }
});

function stream(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 2000\n\n');
  const last = req.headers['last-event-id'];
  let replayed = false;
  if (last) {
    const [boot, n] = String(last).split(':');
    if (boot === BOOT_ID && Number(n) >= (ring[0] ? ring[0].seq - 1 : 0)) {
      for (const m of ring) if (m.seq > Number(n)) write(res, m);
      replayed = true;
    }
  }
  if (!replayed) write(res, { seq: ++seq, event: 'reset', data: JSON.stringify({ reason: last ? 'cannot-resume' : 'connect', bootId: BOOT_ID }) });
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

setInterval(() => { for (const res of clients) res.write(`event: ping\ndata: ${Date.now()}\n\n`); }, 10000).unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Dashboard (read-only) → http://localhost:${PORT}   root: ${ROOT}${IS_REAL_ROOT ? '' : '  [NOT the real ~/.claude — fixture/test data]'}`);
  refreshRegistry().then(initialIndex).catch((e) => { console.error('index failed', e); bootDone = true; });
  setInterval(() => tick().catch((e) => console.error('tick', e)), 1000);
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Start with --port <n>.` : e); process.exit(1); });
