// Overview map: hub → projects → sessions → subagents. Every edge is backed by data
// (session.cwd grouping, parent→child subagent link via the Agent tool_use id).
import { h, reconcile, setText, setClass, ago, fmtNum } from './util.js';
import { S, effectiveSessionState, STATE_LABEL, inWindow, select, nodeState, subState, attentionItems, unseen, notify } from './store.js';
import { Canvas } from './canvas.js';

let cv = null;
let root = null;
let overlay = null;

const CAP = 5;
const SW = 268, SH = 112, UW = 214, UH = 46, PW = 210, PH = 34, HUB = 150;

export function initMap(el) {
  root = el;
  cv = new Canvas(el, { key: 'map' });
  const tb = h('div', { class: 'toolbar' },
    h('div', { class: 'seg', id: 'win-seg' },
      ...[['live', 'Open now'], ['24h', '24h'], ['7d', '7 days'], ['all', 'All']].map(([k, label]) => h('button', { dataset: { win: k }, onclick: () => { S.ui.window = k; try { localStorage.setItem('ad.window', JSON.stringify(k)); } catch { /* ignore */ } cv.userMoved = false; notify('canvas', 'rail', 'header'); } }, label))),
    h('div', { class: 'zoom' },
      h('button', { title: 'Zoom out', onclick: () => cv.zoomBy(0.8) }, '−'),
      h('button', { title: 'Zoom in', onclick: () => cv.zoomBy(1.25) }, '+'),
      h('button', { title: 'Fit all', onclick: () => cv.fit() }, 'Fit')));
  overlay = h('div', { class: 'map-empty hidden' });
  const types = h('div', { class: 'types-strip', id: 'types-strip' });
  const legend = h('div', { class: 'legend' },
    h('span', { class: 'lg' }, h('i', { class: 'dot working' }), 'Working'),
    h('span', { class: 'lg' }, h('i', { class: 'dot idle' }), 'Idle (open)'),
    h('span', { class: 'lg' }, h('i', { class: 'dot historical' }), 'Not running'),
    h('span', { class: 'lg' }, h('i', { class: 'dot unknown' }), 'Unknown'));
  tb.insertBefore(legend, tb.querySelector('.zoom'));
  root.append(tb, overlay, types);
}

export function layoutMap(sessions) {
  const nodes = [];
  const edges = [];
  const N = sessions.length;
  nodes.push({ id: 'hub', type: 'hub', cx: 0, cy: 0, w: HUB, h: HUB });
  if (!N) return { nodes, edges, bounds: { x: -HUB / 2, y: -HUB / 2, w: HUB, h: HUB } };
  const groups = new Map();
  for (const s of sessions) { if (!groups.has(s.project)) groups.set(s.project, []); groups.get(s.project).push(s); }
  const projects = [...groups.keys()].sort();
  // A project with many sessions shows its live/newest ones; the rest fold into one expandable node.
  const hiddenBy = new Map();
  for (const p of projects) {
    const list = groups.get(p);
    if (list.length > CAP && !S.ui.expanded.has(p)) {
      const ranked = [...list].sort((a, b) => ((b.state !== 'historical') - (a.state !== 'historical')) || (b.lastTs || 0) - (a.lastTs || 0));
      const keep = new Set(ranked.slice(0, CAP).map((x) => x.id));
      hiddenBy.set(p, list.length - CAP);
      groups.set(p, list.filter((x) => keep.has(x.id)));
    }
  }
  const total = [...groups.values()].reduce((a, l) => a + l.length + (0), 0) + hiddenBy.size;
  const R2 = Math.max(400, (total * (SW + 40)) / (2 * Math.PI));
  const R1 = Math.min(210, R2 * 0.52);
  let a0 = -Math.PI / 2;
  for (const p of projects) {
    const list = groups.get(p).sort((a, b) => (a.firstTs || 0) - (b.firstTs || 0));
    const extra = hiddenBy.has(p) ? 1 : 0;
    const span = ((list.length + extra) / total) * Math.PI * 2;
    const mid = a0 + span / 2;
    const pid = 'proj:' + p;
    nodes.push({ id: pid, type: 'project', cx: Math.cos(mid) * R1, cy: Math.sin(mid) * R1, w: PW, h: PH, label: p, count: list.length });
    edges.push({ id: `hub>${pid}`, x1: 0, y1: 0, x2: Math.cos(mid) * R1, y2: Math.sin(mid) * R1, kind: 'base' });
    if (extra) {
      const a = a0 + ((list.length + 0.5) / (list.length + 1)) * span;
      const cx = Math.cos(a) * R2, cy = Math.sin(a) * R2;
      nodes.push({ id: 'fold:' + p, type: 'fold', cx, cy, w: SW, h: 52, label: `+${hiddenBy.get(p)} older sessions in ${p}`, project: p });
      edges.push({ id: `${pid}>fold:${p}`, x1: Math.cos(mid) * R1, y1: Math.sin(mid) * R1, x2: cx, y2: cy, kind: 'base' });
    }
    list.forEach((s, j) => {
      const a = a0 + ((j + 0.5) / (list.length + extra)) * span;
      const cx = Math.cos(a) * R2, cy = Math.sin(a) * R2;
      nodes.push({ id: 's:' + s.id, type: 'session', cx, cy, w: SW, h: SH, s });
      edges.push({ id: `${pid}>s:${s.id}`, x1: Math.cos(mid) * R1, y1: Math.sin(mid) * R1, x2: cx, y2: cy, kind: effectiveSessionState(s) });
      const subs = s.subagents.slice(0, 5);
      const R3 = R2 + SW / 2 + UW / 2 + 90;
      const tx = -Math.sin(a), ty = Math.cos(a);
      subs.forEach((u, i) => {
        const off = (i - (subs.length - 1) / 2) * (UH + 14);
        const ux = Math.cos(a) * R3 + tx * off, uy = Math.sin(a) * R3 + ty * off;
        nodes.push({ id: u.id, type: 'sub', cx: ux, cy: uy, w: UW, h: UH, u, s });
        edges.push({ id: `s:${s.id}>${u.id}`, x1: cx, y1: cy, x2: ux, y2: uy, kind: subState(u, s) });
      });
      if (s.subagentTotal > subs.length) {
        const off = ((subs.length) - (subs.length - 1) / 2) * (UH + 14);
        nodes.push({ id: 'more:' + s.id, type: 'more', cx: Math.cos(a) * R3 + tx * off, cy: Math.sin(a) * R3 + ty * off, w: 120, h: 26, label: `+${s.subagentTotal - subs.length} more subagents`, s });
      }
    });
    a0 += span;
  }
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const n of nodes) { minX = Math.min(minX, n.cx - n.w / 2); maxX = Math.max(maxX, n.cx + n.w / 2); minY = Math.min(minY, n.cy - n.h / 2); maxY = Math.max(maxY, n.cy + n.h / 2); }
  return { nodes, edges, rings: [R1, R2], bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

function isSel(n) {
  const sel = S.ui.sel;
  if (!sel) return false;
  if (n.type === 'session') return sel.sessionId === n.s.id && (sel.type === 'session' || !sel.id);
  if (n.type === 'sub') return sel.id === n.u.id;
  return false;
}

function activityLine(s, eff) {
  if (eff === 'working' && s.openTools.length) {
    const t = s.openTools[0];
    return `Running ${t.name}${t.input ? ': ' + t.input : ''}`;
  }
  if (eff === 'working') return s.lastAction ? `Working · last: ${s.lastAction.text}` : 'Working';
  if (s.lastAction) return s.lastAction.text;
  return 'No recorded activity';
}

function makeNode(n) {
  if (n.type === 'hub') return h('div', { class: 'map-node hub' }, h('i', { class: 'ar ar1' }), h('i', { class: 'ar ar2' }), h('i', { class: 'ar ar3' }), h('div', { class: 'hub-t' }, 'Claude Code'), h('div', { class: 'hub-s' }), h('div', { class: 'hub-c' }));
  if (n.type === 'project') return h('div', { class: 'map-node project' }, h('span', { class: 'p-ico' }, '▸'), h('span', { class: 'p-name' }), h('span', { class: 'p-n' }));
  if (n.type === 'more') return h('div', { class: 'map-node more' });
  if (n.type === 'fold') return h('button', { class: 'map-node fold', onclick: (e) => { const p = e.currentTarget.dataset.project; S.ui.expanded.has(p) ? S.ui.expanded.delete(p) : S.ui.expanded.add(p); cv.userMoved = false; notify('canvas'); } });
  if (n.type === 'sub') return h('div', { class: 'map-node sub', onclick: (e) => { e.stopPropagation(); const k = e.currentTarget.dataset.key; select({ type: 'node', sessionId: e.currentTarget.dataset.sid, id: k }); } },
    h('span', { class: 'dot' }), h('span', { class: 'u-type' }), h('span', { class: 'u-desc' }));
  return h('div', { class: 'map-node session',
    onclick: (e) => select({ type: 'session', sessionId: e.currentTarget.dataset.sid }),
    ondblclick: (e) => select({ type: 'session', sessionId: e.currentTarget.dataset.sid }, 'flow') },
  h('div', { class: 'mn-head' }, h('span', { class: 'dot' }), h('span', { class: 'mn-title' }), h('span', { class: 'mn-state' })),
  h('div', { class: 'mn-proj' }),
  h('div', { class: 'mn-act' }),
  h('div', { class: 'mn-foot' }, h('span', { class: 'mn-counts' }), h('span', { class: 'badges' })));
}

function updateNode(el, n) {
  el.style.transform = `translate(${n.cx - n.w / 2}px, ${n.cy - n.h / 2}px)`;
  el.style.width = n.w + 'px'; el.style.height = n.h + 'px';
  if (n.type === 'hub') {
    const sess = [...S.sessions.values()];
    const w = sess.filter((s) => effectiveSessionState(s) === 'working').length;
    const i = sess.filter((s) => effectiveSessionState(s) === 'idle').length;
    setText(el.querySelector('.hub-s'), `${w} working · ${i} idle`);
    setText(el.querySelector('.hub-c'), S.root && !S.realRoot ? 'fixture data' : 'this Mac');
    return;
  }
  if (n.type === 'project') { setText(el.querySelector('.p-name'), n.label); setText(el.querySelector('.p-n'), n.count); el.title = n.label; return; }
  if (n.type === 'more') { setText(el, n.label); return; }
  if (n.type === 'fold') { el.dataset.project = n.project; setText(el, n.label + ' — click to show'); return; }
  if (n.type === 'sub') {
    const st = subState(n.u, n.s);
    el.dataset.sid = n.s.id;
    setClass(el, `map-node sub st-${st}${isSel(n) ? ' sel' : ''}`);
    el.querySelector('.dot').setAttribute('class', `dot ${st}`);
    setText(el.querySelector('.u-type'), n.u.agentType || 'agent');
    setText(el.querySelector('.u-desc'), n.u.description || '');
    el.title = `${n.u.agentType || 'agent'} · ${STATE_LABEL[st]}${n.u.description ? ' · ' + n.u.description : ''}`;
    return;
  }
  const s = n.s;
  const eff = effectiveSessionState(s);
  el.dataset.sid = s.id;
  setClass(el, `map-node session st-${eff}${isSel(n) ? ' sel' : ''}`);
  el.querySelector('.dot').setAttribute('class', `dot ${eff}`);
  setText(el.querySelector('.mn-title'), s.title);
  setText(el.querySelector('.mn-state'), STATE_LABEL[eff]);
  setText(el.querySelector('.mn-proj'), s.project);
  const act = activityLine(s, eff);
  setText(el.querySelector('.mn-act'), act);
  setText(el.querySelector('.mn-counts'), `${fmtNum(s.counts.prompts)} prompts · ${fmtNum(s.counts.tools)} tool calls · ${s.subagentTotal} subagents · ${ago(s.lastTs, S.now)}`);
  const badges = el.querySelector('.badges');
  const items = attentionItems().filter((a) => a.sessionId === s.id);
  const asks = items.filter((a) => a.kind === 'awaiting').length;
  const fails = unseen(items).filter((a) => a.kind !== 'awaiting').length;
  const sig = `${asks}|${fails}`;
  if (badges.dataset.sig !== sig) {
    badges.dataset.sig = sig; badges.textContent = '';
    if (asks) badges.append(h('span', { class: 'badge ask', title: 'This session is waiting for your answer' }, 'Needs you'));
    if (fails) badges.append(h('span', { class: 'badge err', title: 'Failed or blocked tool calls in the last 24h you have not marked seen' }, `${fails} failed`));
  }
}

export function updateMap() {
  if (!cv) return;
  document.querySelectorAll('#win-seg button').forEach((b) => b.classList.toggle('on', b.dataset.win === S.ui.window));
  const list = [...S.sessions.values()].filter((s) => (S.ui.window === 'live' ? s.state !== 'historical' : inWindow(s)));
  const { nodes, edges, bounds, rings = [] } = layoutMap(list);
  drawRings(rings);
  cv.setBounds(bounds);
  reconcile(cv.layer, nodes, (n) => n.id, makeNode, (el, n) => updateNode(el, n));
  reconcile(cv.edges, edges, (e) => e.id, () => h('svg:path', { class: 'edge' }), (el, e) => {
    el.setAttribute('d', `M${e.x1},${e.y1} L${e.x2},${e.y2}`);
    setClass(el, `edge ${e.kind || ''}`);
  });
  overlay.classList.toggle('hidden', list.length > 0);
  if (!list.length) overlay.textContent = S.health && S.health.indexing ? 'Indexing transcript history…' : `No sessions in this window. ${S.ui.window === 'live' ? 'Nothing is open right now — try 24h, 7 days or All.' : 'Try a wider range.'}`;
  const strip = document.getElementById('types-strip');
  const items = S.catalog.items;
  reconcile(strip, items, (c) => c.name, (c) => h('button', { class: 'type-chip', onclick: (e) => select({ type: 'agenttype', id: e.currentTarget.dataset.key, sessionId: null }) }, h('span', { class: 'tn' }), h('span', { class: 'tr' })), (el, c) => {
    setText(el.querySelector('.tn'), c.name);
    setText(el.querySelector('.tr'), c.runs ? `${c.runs} run${c.runs > 1 ? 's' : ''}` : 'no runs seen');
    el.classList.toggle('on', S.ui.sel && S.ui.sel.type === 'agenttype' && S.ui.sel.id === c.name);
    el.title = `${c.name} · ${c.sourceLabel}`;
  });
  strip.dataset.label = 'Agent types';
}

// Decorative range rings behind the hub: inner ring = project folders, outer ring = sessions (structure only, not data).
function drawRings(radii) {
  const els = cv.edges.querySelectorAll('circle.ring');
  for (let i = 0; i < 2; i++) {
    let c = els[i];
    if (!c) { c = h('svg:circle', { class: 'ring', cx: 0, cy: 0 }); cv.edges.prepend(c); }
    c.setAttribute('r', radii[i] || 0);
    c.style.display = radii[i] ? '' : 'none';
  }
}

export function mapCanvas() { return cv; }
