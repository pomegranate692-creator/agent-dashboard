// Flow view for one session: prompt → Claude response → tool calls, with subagents branching off.
// Relationships shown are only those present in the transcript:
//   prompt → response/tool calls (sequence within a prompt), Agent tool_use → subagent run (toolUseId link),
//   subagent → its own tool calls (separate subagent transcript).
import { h, reconcile, setText, setClass, ago, fmtTime, fmtDur, fmtNum, shortModel } from './util.js';
import { S, nodeState, effectiveSessionState, STATE_LABEL, select, notify, ensureLoaded, setView } from './store.js';
import { Canvas } from './canvas.js';

let cv = null, root = null, canvasEl = null, bar = null, banner = null, replayBar = null;
let lastKey = null;
let timer = null;
let model = null;

const CW = 224, COL = 256;
const H = { session: 100, prompt: 118, resp: 118, sub: 106, more: 36 };

// ---------- model ----------
export function buildModel(nodesMap, { cutoff = null } = {}) {
  const all = [...nodesMap.values()].filter((n) => cutoff == null || (n.ts || 0) <= cutoff).sort((a, b) => a.ord - b.ord);
  const prompts = [];
  const byPrompt = new Map();
  for (const n of all) if (n.kind === 'prompt') { const r = { p: n, turns: [], tools: [], subs: [], events: [] }; prompts.push(r); byPrompt.set(n.id, r); }
  const subs = new Map();
  for (const n of all) if (n.kind === 'subagent') subs.set(n.id, { sub: n, turns: [], tools: [], subs: [] });
  const bySubAgentId = new Map();
  for (const s of subs.values()) if (s.sub.agentId) bySubAgentId.set(s.sub.agentId, s);
  const orphans = [];
  for (const n of all) {
    if (n.kind === 'prompt') continue;
    if (n.kind === 'subagent') {
      const s = subs.get(n.id);
      const parentSub = n.scope && n.scope !== 'main' ? bySubAgentId.get(n.scope) : null;
      if (parentSub) parentSub.subs.push(s);
      else { const r = byPrompt.get(n.promptId); if (r) r.subs.push(s); else orphans.push(s); }
      continue;
    }
    if (n.parent && subs.has(n.parent)) {
      const s = subs.get(n.parent);
      if (n.kind === 'turn') s.turns.push(n); else if (n.kind === 'tool' && !n.isAgentCall) s.tools.push(n);
      continue;
    }
    const r = byPrompt.get(n.promptId);
    if (!r) continue;
    if (n.kind === 'turn') r.turns.push(n);
    else if (n.kind === 'tool') { if (!n.isAgentCall) r.tools.push(n); }
    else if (n.kind === 'event') r.events.push(n);
  }
  return { prompts, subs, orphans, all };
}

function toolChips(tools, sess, atTs) {
  const g = new Map();
  for (const t of tools) {
    const c = g.get(t.name) || { name: t.name, n: 0, err: 0, denied: 0, running: 0, unresolved: 0, ids: [] };
    const st = nodeState(t, sess, atTs);
    c.n++; c.ids.push(t.id);
    if (st === 'error') c.err++; else if (st === 'denied' || st === 'rejected') c.denied++; else if (st === 'running') c.running++; else if (st === 'unresolved' || st === 'unknown') c.unresolved++;
    g.set(t.name, c);
  }
  return [...g.values()].sort((a, b) => b.n - a.n);
}

function tally(tools, sess, atTs) {
  const t = { n: tools.length, ok: 0, err: 0, denied: 0, running: 0, unresolved: 0 };
  for (const x of tools) {
    const st = nodeState(x, sess, atTs);
    if (st === 'ok') t.ok++; else if (st === 'error') t.err++; else if (st === 'denied' || st === 'rejected') t.denied++; else if (st === 'running') t.running++; else t.unresolved++;
  }
  return t;
}

export function layoutFlow(m, sess, opts) {
  const { collapsed, atTs, visiblePrompts } = opts;
  const cards = [];
  const edges = [];
  let y = 0;
  const sessCard = { id: 'sess:' + sess.id, type: 'session', x: 0, y: 0, w: CW, h: H.session, sess };
  cards.push(sessCard);
  y = H.session + 36;
  let prevPrompt = sessCard;
  const rows = m.prompts.slice(Math.max(0, m.prompts.length - visiblePrompts));

  const toolsCardH = (tools) => { const nc = Math.min(8, toolChips(tools, sess, atTs).length); return 70 + Math.ceil(nc / 2) * 30; };

  function layoutSub(s, col, top, parentCard) {
    const x = col * COL;
    const c = { id: s.sub.id, type: 'sub', x, y: top, w: CW, h: H.sub, s };
    cards.push(c);
    edges.push({ id: `${parentCard.id}>${c.id}`, from: parentCard, to: c, kind: 'h', state: nodeState(s.sub, sess, atTs) });
    let bottom = top + H.sub;
    let sideBottom = top;
    if (s.tools.length) {
      const g = { id: 'g:' + s.sub.id, type: 'tools', x: x + COL, y: top, w: CW, h: toolsCardH(s.tools), tools: s.tools, ownerId: s.sub.id };
      cards.push(g);
      edges.push({ id: `${c.id}>${g.id}`, from: c, to: g, kind: 'h', state: 'base' });
      sideBottom = top + g.h;
    }
    let nestedTop = Math.max(sideBottom, top) + (s.tools.length ? 12 : 0);
    for (const ns of s.subs) {
      const nb = layoutSub(ns, col + 1, nestedTop, c);
      nestedTop = nb + 12;
    }
    return Math.max(bottom, sideBottom, nestedTop - (s.subs.length ? 12 : 0));
  }

  rows.forEach((r) => {
    const isCollapsed = collapsed.has(r.p.id);
    const pc = { id: r.p.id, type: 'prompt', x: 0, y, w: CW, h: H.prompt, r, collapsed: isCollapsed };
    cards.push(pc);
    if (prevPrompt) edges.push({ id: `${prevPrompt.id}>${pc.id}`, from: prevPrompt, to: pc, kind: 'v', state: 'base' });
    prevPrompt = pc;
    let rowH = H.prompt;
    if (!isCollapsed) {
      const hasWork = r.turns.length || r.tools.length || r.subs.length;
      if (hasWork) {
        const rc = { id: 'r:' + r.p.id, type: 'resp', x: COL, y, w: CW, h: H.resp, r };
        cards.push(rc);
        edges.push({ id: `${pc.id}>${rc.id}`, from: pc, to: rc, kind: 'h', state: 'base' });
        rowH = Math.max(rowH, H.resp);
        let colY = y;
        if (r.tools.length) {
          const g = { id: 'g:' + r.p.id, type: 'tools', x: COL * 2, y: colY, w: CW, h: toolsCardH(r.tools), tools: r.tools, ownerId: r.p.id };
          cards.push(g);
          edges.push({ id: `${rc.id}>${g.id}`, from: rc, to: g, kind: 'h', state: 'base' });
          colY += g.h + 14;
        }
        for (const s of r.subs) {
          const b = layoutSub(s, 2, colY, rc);
          colY = b + 14;
        }
        rowH = Math.max(rowH, colY - y - 14);
      }
    }
    y += rowH + 40;
  });
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  for (const c of cards) { maxX = Math.max(maxX, c.x + c.w); maxY = Math.max(maxY, c.y + c.h); }
  return { cards, edges, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY }, hiddenPrompts: m.prompts.length - rows.length };
}

// ---------- group helpers (used by the detail panel too) ----------
export function groupMembers(m, id) {
  if (id.startsWith('g:')) {
    const owner = id.slice(2);
    if (m.subs.has(owner)) return { kind: 'tools', owner: m.subs.get(owner).sub, items: m.subs.get(owner).tools };
    const r = m.prompts.find((x) => x.p.id === owner);
    return r ? { kind: 'tools', owner: r.p, items: r.tools } : null;
  }
  if (id.startsWith('r:')) {
    const r = m.prompts.find((x) => x.p.id === id.slice(2));
    return r ? { kind: 'turns', owner: r.p, items: r.turns, events: r.events, subs: r.subs.map((s) => s.sub) } : null;
  }
  return null;
}

// ---------- rendering ----------
export function initFlow(el) {
  root = el;
  bar = h('div', { class: 'toolbar flow-bar' });
  banner = h('div', { class: 'mode-banner hidden' });
  replayBar = h('div', { class: 'replay-bar hidden' });
  canvasEl = h('div', { class: 'canvas inner' });
  root.append(h('div', { class: 'flow-top' }, bar, banner, replayBar), canvasEl);
  cv = new Canvas(canvasEl, { key: 'flow.none', minZoom: 0.15, maxZoom: 1.6 });
}

function sessionTimes(nodes) {
  const ts = [];
  for (const n of nodes.values()) if (n.ts && n.kind !== 'turn') ts.push(n.ts);
  ts.sort((a, b) => a - b);
  return ts;
}

function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
function startTimer() {
  stopTimer();
  timer = setInterval(() => {
    const r = S.ui.replay;
    const l = r && S.loaded.get(r.sessionId);
    if (!r || !l) return stopTimer();
    const n = sessionTimes(l.nodes).length;
    if (r.idx >= n - 1) { r.playing = false; stopTimer(); } else r.idx++;
    notify('canvas');
  }, 140);
}

export function updateFlow() {
  if (!cv) return;
  const sel = S.ui.sel;
  const sid = sel && sel.sessionId;
  const sess = sid && S.sessions.get(sid);
  const l = sid && S.loaded.get(sid);
  if (!sess || !l) {
    bar.textContent = '';
    banner.classList.add('hidden'); replayBar.classList.add('hidden');
    reconcile(cv.layer, [], () => '', () => document.createElement('div'));
    reconcile(cv.edges, [], () => '', () => document.createElement('div'));
    if (!canvasEl.querySelector('.flow-empty')) canvasEl.append(h('div', { class: 'flow-empty' }, 'Select a session to see its flow.'));
    canvasEl.querySelector('.flow-empty').textContent = sid && !l ? 'Loading session…' : 'Select a session in the list or on the map to see its flow.';
    return;
  }
  const empty = canvasEl.querySelector('.flow-empty'); if (empty) empty.remove();
  if (lastKey !== sid) { lastKey = sid; cv.switchKey('flow.' + sid); }

  const replay = S.ui.replay && S.ui.replay.sessionId === sid ? S.ui.replay : null;
  const times = sessionTimes(l.nodes);
  const cursor = replay ? times[Math.min(replay.idx, times.length - 1)] : null;
  model = buildModel(l.nodes, { cutoff: cursor });
  const lay = layoutFlow(model, sess, { collapsed: collapsedSet(model), atTs: cursor, visiblePrompts: l.all ? 100000 : 60 });
  cv.setBounds(lay.bounds, 'tail');

  reconcile(cv.layer, lay.cards, (c) => c.id, makeCard, (el, c) => updateCard(el, c, sess, cursor));
  reconcile(cv.edges, lay.edges, (e) => e.id, () => h('svg:path', { class: 'edge' }), (el, e) => {
    const a = e.from, b = e.to;
    let d;
    if (e.kind === 'v') d = `M${a.x + a.w / 2},${a.y + a.h} L${b.x + b.w / 2},${b.y}`;
    else {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + 28;
      const mx = (x1 + x2) / 2;
      d = `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
    }
    el.setAttribute('d', d);
    setClass(el, `edge ${e.state || ''}`);
  });

  renderBar(sess, l, lay, replay, times);
  renderBanner(sess, replay, cursor);
  if ((S.ui.follow && !replay && sess.state !== 'historical') || replay) {
    // Follow mode / replay scrubbing: keep the newest content in view (never zooms).
    const last = lay.cards.filter((c) => c.type === 'prompt').pop();
    if (last) cv.reveal({ x: last.x, y: last.y, w: CW * 3, h: last.h });
  }
}

function collapsedSet(m) {
  // Long sessions: older prompts start collapsed to a single card; the newest stay expanded. The user's own toggles win.
  const set = new Set();
  const n = m.prompts.length;
  m.prompts.forEach((r, i) => {
    const user = S.ui.collapsed.get ? S.ui.collapsed.get(r.p.id) : undefined;
    const dflt = n > 14 && i < n - 8;
    if (user === undefined ? dflt : user) set.add(r.p.id);
  });
  return set;
}

function renderBar(sess, l, lay, replay, times) {
  const eff = effectiveSessionState(sess);
  const items = [
    h('button', { class: 'crumb', onclick: () => setView('map') }, '◂ All agents'),
    h('span', { class: 'sep' }, '›'),
    h('span', { class: 'crumb cur', title: sess.title }, sess.title),
    h('span', { class: `pill ${eff}` }, STATE_LABEL[eff]),
  ];
  if (l.promptsIncluded < l.promptTotal || lay.hiddenPrompts > 0) {
    items.push(h('button', { class: 'btn', onclick: async () => { await ensureLoaded(sess.id, { all: true }); } }, `Showing newest ${l.promptsIncluded} of ${l.promptTotal} prompts · Load all`));
  }
  items.push(h('span', { class: 'grow' }));
  if (sess.state !== 'historical' && !replay) items.push(h('label', { class: 'toggle', title: 'Keep the newest activity in view' }, h('input', { type: 'checkbox', checked: S.ui.follow ? true : null, onchange: (e) => { S.ui.follow = e.target.checked; notify('canvas'); } }), 'Follow latest'));
  items.push(h('button', { class: 'btn' + (replay ? ' on' : ''), onclick: () => toggleReplay(sess, times) }, replay ? 'Exit replay' : '▶ Replay'));
  items.push(h('div', { class: 'zoom' }, h('button', { onclick: () => cv.zoomBy(0.8) }, '−'), h('button', { onclick: () => cv.zoomBy(1.25) }, '+'), h('button', { onclick: () => cv.fit() }, 'Fit')));
  const sig = items.map((i) => i.textContent).join('|') + (S.ui.follow ? 'F' : '') + (replay ? 'R' : '');
  if (bar.dataset.sig !== sig) { bar.dataset.sig = sig; bar.textContent = ''; bar.append(...items); }
}

function toggleReplay(sess, times) {
  if (S.ui.replay && S.ui.replay.sessionId === sess.id) { S.ui.replay = null; stopTimer(); }
  else { S.ui.replay = { sessionId: sess.id, idx: Math.max(0, Math.floor(times.length / 3)), playing: false }; }
  bar.dataset.sig = '';
  notify('canvas');
}

function renderBanner(sess, replay, cursor) {
  let text = '', cls = '';
  const eff = effectiveSessionState(sess);
  if (replay) { text = `REPLAY — showing state as of ${new Date(cursor).toLocaleString()} reconstructed from timestamps. This is not live.`; cls = 'replay'; }
  else if (S.conn !== 'live') { text = `Visibility lost since ${fmtTime(S.lostSince)} — showing the last known state. The session may still be running or may have finished.`; cls = 'lost'; }
  else if (eff === 'historical') { text = `Historical — no live process is registered for this session. Last transcript activity ${ago(sess.lastTs, S.now)}. Anything shown as "No result recorded" never got a result written.`; cls = 'hist'; }
  else { text = `Live — observing ${sess.live && sess.live.status === 'busy' ? 'a working' : 'an idle'} session (pid ${sess.live && sess.live.pid}). New activity appears as it is written to the transcript.`; cls = 'live'; }
  setText(banner, text); banner.title = text;
  setClass(banner, `mode-banner ${cls}`);
  // replay controls
  if (replay) {
    const l = S.loaded.get(sess.id);
    const times = sessionTimes(l.nodes);
    replayBar.classList.remove('hidden');
    const sig = `${replay.playing}|${times.length}`;
    if (replayBar.dataset.sig !== sig) {
      replayBar.dataset.sig = sig; replayBar.textContent = '';
      const slider = h('input', { type: 'range', min: 0, max: Math.max(0, times.length - 1), value: replay.idx, oninput: (e) => { replay.idx = Number(e.target.value); replay.playing = false; stopTimer(); notify('canvas'); } });
      replayBar.append(
        h('button', { class: 'btn', onclick: () => { replay.playing = !replay.playing; if (replay.playing) { if (replay.idx >= times.length - 1) replay.idx = 0; startTimer(); } else stopTimer(); replayBar.dataset.sig = ''; notify('canvas'); } }, replay.playing ? '❚❚ Pause' : '▶ Play'),
        slider, h('span', { class: 'rt' }));
    }
    const sl = replayBar.querySelector('input'); if (sl && Number(sl.value) !== replay.idx) sl.value = replay.idx;
    setText(replayBar.querySelector('.rt'), `${replay.idx + 1} / ${times.length} events · ${fmtTime(cursor)}`);
  } else replayBar.classList.add('hidden');
}

// ---------- cards ----------
function makeCard(c) {
  const el = h('div', { class: `card ${c.type}`, onclick: (e) => onCardClick(e, el) });
  return el;
}

function cardSelected(c) {
  const sel = S.ui.sel;
  if (!sel) return false;
  if (c.type === 'session') return sel.type === 'session' && sel.sessionId === c.sess.id;
  if (sel.id === c.id) return true;
  if (c.type === 'tools') {
    if (sel.type === 'node') { const n = c.tools.find((t) => t.id === sel.id); return !!n; }
  }
  if (c.type === 'resp' && sel.type === 'node') return c.r.turns.some((t) => t.id === sel.id);
  return false;
}

function onCardClick(e, el) {
  if (e.target.closest('.chip, .collapse-btn')) return;
  const id = el.dataset.key;
  const sid = S.ui.sel && S.ui.sel.sessionId;
  if (id.startsWith('sess:')) return select({ type: 'session', sessionId: sid });
  if (id.startsWith('g:') || id.startsWith('r:')) return select({ type: 'group', sessionId: sid, id });
  select({ type: 'node', sessionId: sid, id });
}

function chipEl(sid) {
  return h('button', { class: 'chip', onclick: (e) => { e.stopPropagation(); select({ type: 'group', sessionId: sid, id: e.currentTarget.closest('.card').dataset.key, filter: e.currentTarget.dataset.name }); } });
}

function updateCard(el, c, sess, atTs) {
  el.style.transform = `translate(${c.x}px, ${c.y}px)`;
  el.style.width = c.w + 'px';
  el.style.height = c.h + 'px';
  const sel = cardSelected(c);
  if (c.type === 'session') {
    const eff = effectiveSessionState(sess);
    setClass(el, `card session st-${eff}${sel ? ' sel' : ''}`);
    fill(el, ['head', 'title', 'meta'], () => ({
      head: h('div', { class: 'c-head' }, h('span', { class: 'c-kind' }, 'SESSION'), h('span', { class: `dot ${eff}` }), h('span', { class: 'c-time' }, STATE_LABEL[eff])),
      title: h('div', { class: 'c-title clamp2' }, sess.title),
      meta: h('div', { class: 'c-meta' }, sess.project + (sess.version ? ` · v${sess.version}` : '')),
    }), `${eff}|${sess.title}|${sess.project}`);
    return;
  }
  if (c.type === 'prompt') {
    const n = c.r.p;
    setClass(el, `card prompt${sel ? ' sel' : ''}`);
    const tl = tally(c.r.tools, sess, atTs);
    const subN = c.r.subs.length;
    const sig = `${n.text}|${c.collapsed}|${tl.n}|${subN}|${c.r.turns.length}`;
    fill(el, ['head', 'body', 'foot'], () => ({
      head: h('div', { class: 'c-head' }, h('span', { class: 'c-kind' }, 'PROMPT'), n.origin && n.origin !== 'human' ? h('span', { class: 'tag' }, n.origin) : null, h('span', { class: 'c-time' }, fmtTime(n.ts)),
        h('button', { class: 'collapse-btn', title: c.collapsed ? 'Expand this prompt\'s activity' : 'Collapse', onclick: (e) => { e.stopPropagation(); const cur = S.ui.collapsed.get(n.id); S.ui.collapsed.set(n.id, cur === undefined ? !c.collapsed : !cur); notify('canvas'); } }, c.collapsed ? '▸' : '▾')),
      body: h('div', { class: 'c-body clamp3' }, n.text),
      foot: h('div', { class: 'c-foot' }, c.collapsed ? `${tl.n} tool calls · ${subN} subagent${subN === 1 ? '' : 's'} · ${c.r.turns.length} steps` : ''),
    }), sig);
    return;
  }
  if (c.type === 'resp') {
    const turns = c.r.turns;
    const last = [...turns].reverse().find((t) => t.preview);
    const models = [...new Set(turns.map((t) => shortModel(t.model)).filter(Boolean))];
    const first = turns[0], end = turns[turns.length - 1];
    const dur = first && end ? (end.ts - first.ts) : null;
    setClass(el, `card resp${sel ? ' sel' : ''}`);
    const sig = `${turns.length}|${last && last.preview}|${models.join()}|${dur}`;
    fill(el, ['head', 'body', 'foot'], () => ({
      head: h('div', { class: 'c-head' }, h('span', { class: 'c-kind' }, 'CLAUDE'), models.length ? h('span', { class: 'tag' }, models[0]) : null, h('span', { class: 'c-time' }, first ? fmtTime(first.ts) : '')),
      body: h('div', { class: 'c-body clamp3' }, last ? last.preview : 'No text reply recorded (tool-only steps)'),
      foot: h('div', { class: 'c-foot' }, `${turns.length} step${turns.length === 1 ? '' : 's'}${dur != null && dur > 0 ? ' · over ' + fmtDur(dur) : ''}`),
    }), sig);
    return;
  }
  if (c.type === 'tools') {
    const tl = tally(c.tools, sess, atTs);
    const chips = toolChips(c.tools, sess, atTs);
    setClass(el, `card tools${sel ? ' sel' : ''}${tl.err ? ' has-err' : ''}`);
    const sig = chips.map((x) => `${x.name}:${x.n}:${x.err}:${x.denied}:${x.running}:${x.unresolved}`).join(',') + '|' + (S.ui.sel && S.ui.sel.type === 'node' ? S.ui.sel.id : '');
    fill(el, ['head', 'chips', 'foot'], () => ({
      head: h('div', { class: 'c-head' }, h('span', { class: 'c-kind' }, 'TOOL CALLS'), h('span', { class: 'c-time' }, String(tl.n))),
      chips: (() => {
        const w = h('div', { class: 'chips' });
        for (const x of chips.slice(0, 8)) {
          const sev = x.err ? 'err' : x.denied ? 'warn' : x.running ? 'run' : x.unresolved ? 'unres' : 'ok';
          const b = chipEl(sess.id); b.dataset.name = x.name; b.classList.add(sev);
          b.append(h('span', {}, x.name), h('b', {}, x.n > 1 ? '×' + x.n : ''));
          b.title = `${x.name}: ${x.n}${x.err ? `, ${x.err} failed` : ''}${x.denied ? `, ${x.denied} blocked` : ''}${x.running ? `, ${x.running} running` : ''}${x.unresolved ? `, ${x.unresolved} with no result recorded` : ''}`;
          w.append(b);
        }
        if (chips.length > 8) w.append(h('span', { class: 'chip more' }, `+${chips.length - 8} more`));
        return w;
      })(),
      foot: h('div', { class: 'c-foot' }, [tl.ok ? `${tl.ok} ok` : '', tl.err ? `${tl.err} failed` : '', tl.denied ? `${tl.denied} blocked` : '', tl.running ? `${tl.running} running` : '', tl.unresolved ? `${tl.unresolved} no result` : ''].filter(Boolean).join(' · ')),
    }), sig);
    return;
  }
  if (c.type === 'sub') {
    const sub = c.s.sub;
    const st = nodeState(sub, sess, atTs);
    setClass(el, `card sub st-${st}${sel ? ' sel' : ''}`);
    const st2 = sub.stats || {};
    const tl = c.s.tools.length;
    const sig = `${st}|${sub.agentType}|${sub.description}|${tl}|${st2.durationMs}|${st2.totalTokens}`;
    fill(el, ['head', 'title', 'foot'], () => ({
      head: h('div', { class: 'c-head' }, h('span', { class: 'c-kind' }, 'SUBAGENT'), h('span', { class: 'tag type' }, sub.agentType || 'agent'), h('span', { class: `dot ${st}` }), h('span', { class: 'c-time' }, STATE_LABEL[st])),
      title: h('div', { class: 'c-title clamp2' }, sub.description || '(no description)'),
      foot: h('div', { class: 'c-foot' }, [`${tl} tool call${tl === 1 ? '' : 's'}`, st2.durationMs != null ? fmtDur(st2.durationMs) : '', st2.totalTokens != null ? `${fmtNum(st2.totalTokens)} tokens reported` : ''].filter(Boolean).join(' · ')),
    }), sig);
  }
}

// Replace card parts only when their signature changed, so hover/focus/selection aren't disturbed.
function fill(el, parts, build, sig) {
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const b = build();
  el.textContent = '';
  for (const p of parts) if (b[p]) el.append(b[p]);
}

export function flowModel() { return model; }
export function flowCanvas() { return cv; }
export function focusCard(id) {
  if (!cv) return false;
  const el = cv.layer.querySelector(`[data-key="${CSS.escape(id)}"]`);
  if (!el) return false;
  const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.style.transform);
  if (!m) return false;
  const r = { x: Number(m[1]), y: Number(m[2]), w: el.offsetWidth, h: el.offsetHeight };
  const vr = canvasEl.getBoundingClientRect();
  // Centre on the card when it's off-screen; otherwise leave the viewport alone.
  const left = r.x * cv.v.k + cv.v.x, top = r.y * cv.v.k + cv.v.y;
  if (left < 0 || top < 0 || left + r.w * cv.v.k > vr.width || top + r.h * cv.v.k > vr.height) cv.focus(r);
  return true;
}
