// Client state, derived states, and the live connection (SSE with reconnect + resync).
import { lsGet, lsSet } from './util.js';

export const S = {
  boot: null,
  conn: 'connecting', // connecting | live | lost
  lostSince: null,
  lastMsg: 0,
  stateSeq: 0,
  now: Date.now(),
  root: null, realRoot: true,
  health: null,
  sessions: new Map(),
  catalog: { items: [], searched: [] },
  feed: new Map(), // nodeId -> node (recent activity across sessions)
  loaded: new Map(), // sessionId -> { nodes: Map, promptTotal, promptsIncluded, seq, loading }
  details: new Map(), // `${sessionId}|${nodeId}|${version}` -> detail
  seen: new Set(lsGet('ad.seen', [])),
  ui: {
    view: 'map', // map | flow
    sel: null, // { type: 'session'|'node'|'agenttype'|'group', sessionId, id, ... }
    window: lsGet('ad.window', '24h'),
    feedFilter: 'all',
    feedOpen: lsGet('ad.feedOpen', true),
    railHistory: lsGet('ad.railHistory', false),
    collapsed: new Map(), // promptId -> bool: user toggles of collapsed prompt rows in the flow
    replay: null, // { sessionId, idx, playing }
    follow: false,
    expanded: new Set(), // projects whose sessions are all shown on the map
  },
};

const listeners = new Set();
let scheduled = false;
const dirty = new Set();
export function subscribe(fn) { listeners.add(fn); }
export function notify(...parts) {
  parts.forEach((p) => dirty.add(p));
  if (scheduled) return;
  scheduled = true;
  // rAF is paused in hidden tabs/panes, so a timer backs it up: updates keep flowing while the page is in the background.
  const run = () => {
    if (!scheduled) return;
    scheduled = false;
    const d = new Set(dirty); dirty.clear();
    for (const fn of listeners) { try { fn(d); } catch (e) { console.error(e); } }
  };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}

// ---------- derived state ----------
export function effectiveSessionState(s) {
  if (!s) return 'historical';
  if (S.conn !== 'live' && s.state !== 'historical') return 'unknown';
  return s.state;
}

export const STATE_LABEL = {
  working: 'Working', idle: 'Idle', historical: 'Not running', unknown: 'Unknown',
  running: 'Running', unresolved: 'No result recorded', ok: 'Done', error: 'Failed', denied: 'Blocked by permission',
  rejected: 'Declined', completed: 'Completed', failed: 'Failed', async: 'Background · no recent activity, not reported done', pending: 'Pending',
};

const ACTIVE_SUB_MS = 45000;

// Status of a tool/subagent node as of "now" (or as of the replay cursor).
export function nodeState(n, sess, atTs = null) {
  if (n.kind !== 'tool' && n.kind !== 'subagent') return null;
  let st = n.status;
  if (atTs != null) {
    if (n.endTs && n.endTs > atTs) st = 'pending';
    if (st === 'async') st = 'pending';
    else if (!n.endTs && st === 'pending') st = 'pending';
    if (st === 'pending') return 'running';
    return st;
  }
  if (st !== 'pending' && st !== 'async') return st;
  const eff = effectiveSessionState(sess);
  if (eff === 'unknown') return 'unknown';
  if (st === 'async') {
    if (eff === 'historical') return 'unresolved';
    // A background agent counts as running only while its own transcript is still being written.
    return n.lastActivityTs && S.now - n.lastActivityTs <= ACTIVE_SUB_MS ? 'running' : 'async';
  }
  return eff === 'working' ? 'running' : 'unresolved';
}

// State of a subagent summary row (as sent in the session list).
export function subState(u, sess) {
  return nodeState({ kind: 'subagent', status: u.status, endTs: u.endTs, lastActivityTs: u.lastActivityTs }, sess);
}

export function sessionNodes(sessionId) {
  const l = S.loaded.get(sessionId);
  return l ? l.nodes : null;
}

export function sessionOf(id) { return S.sessions.get(id) || null; }

export function windowMs() { return { live: 0, '24h': 864e5, '7d': 6048e5, all: Infinity }[S.ui.window] ?? 864e5; }

export function inWindow(s) {
  if (s.state !== 'historical') return true;
  const w = windowMs();
  return w === Infinity || (w > 0 && S.now - (s.lastTs || 0) <= w);
}

export function attentionItems() {
  const items = [];
  const cutoff = S.now - 864e5;
  for (const s of S.sessions.values()) {
    if (s.awaitingUser) items.push({ id: 'await:' + s.awaitingUser.id, kind: 'awaiting', level: 'ask', ts: s.awaitingUser.ts, sessionId: s.id, nodeId: s.awaitingUser.id, text: `Waiting for your answer: ${s.awaitingUser.input || s.awaitingUser.name}`, live: true });
    for (const a of s.attention) if (a.ts >= cutoff) items.push({ ...a, sessionId: s.id });
  }
  items.sort((a, b) => b.ts - a.ts);
  return items;
}
export function unseen(items) { return items.filter((i) => i.kind === 'awaiting' || !S.seen.has(i.id)); }
export function markSeen(ids) { ids.forEach((i) => S.seen.add(i)); lsSet('ad.seen', [...S.seen].slice(-800)); notify('header', 'detail'); }

// ---------- selection + hash routing ----------
export function select(sel, view) {
  S.ui.sel = sel;
  expandFor(sel);
  if (view) S.ui.view = view;
  if (sel && sel.sessionId) ensureLoaded(sel.sessionId);
  writeHash();
  notify('rail', 'canvas', 'detail', 'header', 'feed');
}
// Selecting something inside a collapsed prompt row opens that row so the card can be shown.
function expandFor(sel) {
  if (!sel || !sel.id || !sel.sessionId) return;
  const l = S.loaded.get(sel.sessionId);
  if (!l) return;
  let key = sel.id;
  if (/^[gr]:/.test(key)) key = key.slice(2);
  const n = l.nodes.get(key);
  const pid = n ? (n.kind === 'prompt' ? n.id : n.promptId) : null;
  if (pid) S.ui.collapsed.set(pid, false);
}
export function setView(view) { S.ui.view = view; writeHash(); notify('canvas', 'rail', 'header'); }

function writeHash() {
  const sel = S.ui.sel;
  const parts = [`v=${S.ui.view}`];
  if (sel) { if (sel.sessionId) parts.push('s=' + encodeURIComponent(sel.sessionId)); if (sel.id) parts.push('n=' + encodeURIComponent(sel.id)); if (sel.type) parts.push('t=' + sel.type); }
  const next = '#' + parts.join('&');
  if (location.hash !== next) history.replaceState(null, '', next);
}
export function readHash() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ''));
  const v = p.get('v');
  if (v === 'flow' || v === 'map') S.ui.view = v;
  const s = p.get('s');
  if (s) S.ui.sel = { type: p.get('t') || 'session', sessionId: s, id: p.get('n') || null };
}

// ---------- loading ----------
export async function ensureLoaded(sessionId, { all = false, force = false } = {}) {
  let l = S.loaded.get(sessionId);
  if (l && !force && l.loading) return l.loading;
  if (l && !force && !all) return;
  if (l && !force && all && l.promptsIncluded >= l.promptTotal) return;
  const p = (async () => {
    const r = await fetch(`/api/session?id=${encodeURIComponent(sessionId)}${all ? '&all=1' : '&prompts=30'}`);
    if (!r.ok) return;
    const d = await r.json();
    const nodes = new Map();
    for (const n of d.nodes) nodes.set(n.id, n);
    const prev = S.loaded.get(sessionId);
    S.loaded.set(sessionId, { nodes, promptTotal: d.promptTotal, promptsIncluded: d.promptsIncluded, seq: d.seq, loading: null, all: all || (prev && prev.all) });
    S.sessions.set(sessionId, d.summary);
    if (S.ui.sel && S.ui.sel.sessionId === sessionId) expandFor(S.ui.sel);
    notify('canvas', 'detail', 'rail');
  })();
  if (l) l.loading = p; else S.loaded.set(sessionId, { nodes: new Map(), promptTotal: 0, promptsIncluded: 0, seq: 0, loading: p });
  await p.catch(() => {});
}

async function loadState() {
  const r = await fetch('/api/state', { cache: 'no-store' });
  const d = await r.json();
  S.boot = d.bootId; S.stateSeq = d.seq; S.now = d.now; S.root = d.root; S.realRoot = d.realRoot; S.health = d.health;
  S.sessions = new Map(d.sessions.map((s) => [s.id, s]));
  S.catalog = d.catalog;
  S.feed = new Map(d.feed.map((n) => [n.id, n]));
  return d;
}

// ---------- live connection ----------
let es = null;
let watchdog = null;
const numSeq = (e) => Number(String(e.lastEventId || '').split(':')[1] || 0);

export function connect() {
  if (es) es.close();
  es = new EventSource('/api/stream');
  es.onopen = () => { S.lastMsg = Date.now(); };
  es.onerror = () => {
    if (S.conn !== 'lost') { S.conn = 'lost'; S.lostSince = Date.now(); notify('header', 'rail', 'canvas', 'detail', 'feed'); }
  };
  const alive = () => {
    S.lastMsg = Date.now();
    if (S.conn !== 'live') { S.conn = 'live'; S.lostSince = null; notify('header', 'rail', 'canvas', 'detail', 'feed'); }
  };
  es.addEventListener('ping', alive);
  es.addEventListener('reset', async () => {
    alive();
    try {
      await loadState();
      for (const id of S.loaded.keys()) ensureLoaded(id, { force: true, all: S.loaded.get(id).all });
      if (S.ui.sel && S.ui.sel.sessionId) ensureLoaded(S.ui.sel.sessionId, { force: true });
    } catch { /* next reconnect retries */ }
    notify('header', 'rail', 'canvas', 'detail', 'feed');
  });
  es.addEventListener('node', (e) => {
    alive();
    const seq = numSeq(e);
    const { sessionId, node } = JSON.parse(e.data);
    if (seq && seq <= S.stateSeq && !S.loaded.get(sessionId)) { /* already covered by snapshot */ }
    const l = S.loaded.get(sessionId);
    if (l && !(seq && seq <= l.seq)) {
      const prev = l.nodes.get(node.id);
      l.nodes.set(node.id, prev ? { ...prev, ...node } : node);
      if (node.kind === 'prompt' && !prev) { l.promptTotal++; l.promptsIncluded++; }
      notify('canvas', 'detail');
    }
    if (!(seq && seq <= S.stateSeq)) {
      if (node.kind !== 'turn' || node.preview) { const prev = S.feed.get(node.id); S.feed.set(node.id, { ...(prev || {}), ...node }); notify('feed'); }
    }
  });
  es.addEventListener('session', (e) => {
    alive();
    const s = JSON.parse(e.data);
    S.sessions.set(s.id, s);
    S.now = Date.now();
    notify('rail', 'header', 'canvas', 'detail');
  });
  clearInterval(watchdog);
  watchdog = setInterval(() => {
    if (Date.now() - S.lastMsg > 30000 && S.conn === 'live') {
      S.conn = 'lost'; S.lostSince = S.lastMsg; notify('header', 'rail', 'canvas', 'detail', 'feed');
      connect();
    }
  }, 5000);
}

export async function boot() {
  readHash();
  await loadState();
  if (S.health && S.health.indexing) {
    const poll = setInterval(async () => {
      try { await loadState(); notify('header', 'rail', 'canvas', 'feed'); if (!S.health.indexing) { clearInterval(poll); } } catch { /* retry */ }
    }, 1500);
  }
  if (S.ui.sel && S.ui.sel.sessionId) ensureLoaded(S.ui.sel.sessionId);
  connect();
  setInterval(() => { S.now = Date.now(); notify('tick'); }, 5000);
  notify('header', 'rail', 'canvas', 'detail', 'feed');
}
