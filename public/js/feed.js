// Bottom activity feed: observable actions across sessions, newest first, deduped by node id.
import { h, reconcile, setText, setClass, fmtTime } from './util.js';
import { S, nodeState, STATE_LABEL, select, notify } from './store.js';

let root, list, filters;
const FILTERS = [['all', 'All'], ['fail', 'Failures'], ['sub', 'Subagents'], ['prompt', 'Prompts'], ['sess', 'Selected session']];

export function initFeed(el) {
  root = el;
  filters = h('div', { class: 'feed-filters' }, ...FILTERS.map(([k, l]) => h('button', { dataset: { f: k }, onclick: () => { S.ui.feedFilter = k; notify('feed'); } }, l)));
  list = h('div', { class: 'feed-list scrollable' });
  root.append(
    h('div', { class: 'feed-head' }, h('h2', {}, 'Recent activity'), filters, h('span', { class: 'grow' }),
      h('span', { class: 'feed-note' }, 'observable actions only — no reasoning shown'),
      h('button', { class: 'btn', onclick: () => { S.ui.feedOpen = !S.ui.feedOpen; try { localStorage.setItem('ad.feedOpen', JSON.stringify(S.ui.feedOpen)); } catch { /* ignore */ } notify('feed'); } }, 'Hide')),
    list);
}

function describe(n, sess) {
  if (n.kind === 'prompt') return { icon: 'P', text: n.text, label: 'Prompt', st: 'prompt' };
  if (n.kind === 'turn') return { icon: 'C', text: n.preview, label: 'Claude replied', st: 'turn' };
  if (n.kind === 'tool') { const st = nodeState(n, sess); return { icon: 'T', text: `${n.name}${n.input ? ' — ' + n.input : ''}`, label: STATE_LABEL[st] || '', st }; }
  if (n.kind === 'subagent') { const st = nodeState(n, sess); return { icon: 'A', text: `${n.agentType || 'agent'}: ${n.description || ''}`, label: STATE_LABEL[st] || '', st }; }
  return { icon: '!', text: n.text, label: n.subtype === 'api_error' ? 'API error' : 'Event', st: n.subtype === 'api_error' ? 'error' : 'ok' };
}

export function updateFeed() {
  root.classList.toggle('collapsed', !S.ui.feedOpen);
  document.getElementById('feed-open').classList.toggle('hidden', S.ui.feedOpen);
  filters.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.f === S.ui.feedFilter));
  if (!S.ui.feedOpen) return;
  const selSid = S.ui.sel && S.ui.sel.sessionId;
  let rows = [...S.feed.values()];
  const f = S.ui.feedFilter;
  rows = rows.filter((n) => {
    const sess = S.sessions.get(n.sessionId);
    if (f === 'fail') { const st = nodeState(n, sess); return ['error', 'denied', 'failed', 'rejected'].includes(st) || (n.kind === 'event' && n.subtype === 'api_error'); }
    if (f === 'sub') return n.kind === 'subagent';
    if (f === 'prompt') return n.kind === 'prompt';
    if (f === 'sess') return n.sessionId === selSid;
    return true;
  });
  rows.sort((a, b) => b.ts - a.ts);
  rows = rows.slice(0, 150);
  reconcile(list, rows, (n) => n.id, () => h('div', { class: 'frow', onclick: (e) => { const el = e.currentTarget; select({ type: 'node', sessionId: el.dataset.sid, id: el.dataset.key }); } },
    h('span', { class: 'f-time' }), h('span', { class: 'f-ico' }), h('span', { class: 'f-sess' }), h('span', { class: 'f-text' }), h('span', { class: 'f-st' })), (el, n) => {
    const sess = S.sessions.get(n.sessionId);
    const d = describe(n, sess);
    el.dataset.sid = n.sessionId;
    setClass(el, `frow k-${n.kind} st-${d.st}${S.ui.sel && S.ui.sel.id === n.id ? ' sel' : ''}`);
    setText(el.querySelector('.f-time'), fmtTime(n.ts));
    setText(el.querySelector('.f-ico'), d.icon);
    setText(el.querySelector('.f-sess'), sess ? sess.title : n.sessionId.slice(0, 8));
    setText(el.querySelector('.f-text'), d.text || '');
    setText(el.querySelector('.f-st'), d.label);
    el.title = d.text || '';
  });
  if (!rows.length) { if (!list.querySelector('.f-empty')) list.append(h('div', { class: 'f-empty' }, '')); setText(list.querySelector('.f-empty'), 'Nothing matches this filter in the last 3 days.'); }
  else { const e = list.querySelector('.f-empty'); if (e) e.remove(); }
}
