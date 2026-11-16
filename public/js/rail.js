// Left rail: agent overview grid (sessions grouped by what they are doing right now) + configured agent types.
import { h, reconcile, setText, setClass, ago, fmtNum } from './util.js';
import { S, effectiveSessionState, STATE_LABEL, inWindow, select, nodeState, subState, attentionItems, unseen, notify } from './store.js';

let root, list;

export function initRail(el) {
  root = el;
  root.append(
    h('div', { class: 'rail-head' }, h('h2', {}, 'Agents'), h('span', { class: 'rail-sub', id: 'rail-sub' })),
    list = h('div', { class: 'rail-list scrollable' }));
}

function section(key, title, count, note) { return { key: 'h:' + key, head: true, title, count, note }; }

function makeHead() { return h('div', { class: 'rail-sec' }, h('span', { class: 'rs-t' }), h('span', { class: 'rs-n' }), h('span', { class: 'rs-note' })); }

function makeCard() {
  return h('div', { class: 'rcard', onclick: (e) => { if (e.target.closest('.r-sub')) return; select({ type: 'session', sessionId: e.currentTarget.dataset.key.slice(2) }); },
    ondblclick: (e) => select({ type: 'session', sessionId: e.currentTarget.dataset.key.slice(2) }, 'flow') },
  h('div', { class: 'r-head' }, h('span', { class: 'dot' }), h('span', { class: 'r-title' }), h('span', { class: 'r-age' })),
  h('div', { class: 'r-proj' }),
  h('div', { class: 'r-act' }),
  h('div', { class: 'r-subs' }),
  h('div', { class: 'r-badges' }));
}

function activity(s, eff) {
  if (eff === 'unknown') return 'Visibility lost — last known: ' + (s.lastAction ? s.lastAction.text : 'no activity');
  if (eff === 'working') {
    if (s.openTools.length) { const t = s.openTools[0]; return `Running ${t.name}${t.input ? ' — ' + t.input : ''}`; }
    return s.lastAction ? `Working · last: ${s.lastAction.text}` : 'Working';
  }
  if (eff === 'idle') return s.lastAction ? `Waiting for input · last: ${s.lastAction.text}` : 'Waiting for input';
  return s.lastAction ? `Last: ${s.lastAction.text}` : 'No recorded activity';
}

function updateCard(el, s) {
  const eff = effectiveSessionState(s);
  const sel = S.ui.sel && S.ui.sel.sessionId === s.id;
  setClass(el, `rcard st-${eff}${sel ? ' sel' : ''}`);
  el.querySelector('.dot').setAttribute('class', `dot ${eff}`);
  setText(el.querySelector('.r-title'), s.title);
  setText(el.querySelector('.r-age'), eff === 'working' ? STATE_LABEL.working : ago(s.lastTs, S.now));
  setText(el.querySelector('.r-proj'), s.project);
  setText(el.querySelector('.r-act'), activity(s, eff));
  const subs = s.subagents.filter((u) => subState(u, s) === 'running').concat(s.subagents.filter((u) => subState(u, s) !== 'running')).slice(0, eff === 'historical' ? 2 : 4);
  reconcile(el.querySelector('.r-subs'), subs, (u) => u.id, (u) => h('div', { class: 'r-sub', onclick: (e) => { e.stopPropagation(); select({ type: 'node', sessionId: s.id, id: e.currentTarget.dataset.key }, 'flow'); } }, h('span', { class: 'dot' }), h('span', { class: 'rs-type' }), h('span', { class: 'rs-desc' })), (row, u) => {
    const st = subState(u, s);
    row.querySelector('.dot').setAttribute('class', `dot ${st}`);
    setText(row.querySelector('.rs-type'), u.agentType || 'agent');
    setText(row.querySelector('.rs-desc'), u.description || STATE_LABEL[st]);
    row.title = `${STATE_LABEL[st]}${u.description ? ' · ' + u.description : ''}`;
    setClass(row, `r-sub st-${st}${S.ui.sel && S.ui.sel.id === u.id ? ' sel' : ''}`);
  });
  const items = attentionItems().filter((a) => a.sessionId === s.id);
  const asks = items.filter((a) => a.kind === 'awaiting').length;
  const fails = unseen(items).filter((a) => a.kind !== 'awaiting').length;
  const b = el.querySelector('.r-badges');
  const sig = `${asks}|${fails}|${s.subagentTotal}|${s.counts.prompts}|${s.counts.tools}|${s.dupes || 0}`;
  if (b.dataset.sig !== sig) {
    b.dataset.sig = sig; b.textContent = '';
    if (asks) b.append(h('span', { class: 'badge ask' }, 'Waiting for your answer'));
    if (s.dupes) b.append(h('span', { class: 'badge plain', title: 'Other sessions with the same title in the same project are folded into this card' }, `+${s.dupes} similar sessions`));
    if (fails) b.append(h('span', { class: 'badge err' }, `${fails} failed in 24h`));
    b.append(h('span', { class: 'badge plain' }, `${fmtNum(s.counts.prompts)} prompts · ${fmtNum(s.counts.tools)} tools${s.subagentTotal ? ' · ' + s.subagentTotal + ' subagents' : ''}`));
  }
}

function makeType() {
  return h('div', { class: 'tcard', onclick: (e) => select({ type: 'agenttype', id: e.currentTarget.dataset.key.slice(2), sessionId: null }) },
    h('div', { class: 't-head' }, h('span', { class: 't-name' }), h('span', { class: 't-src' })),
    h('div', { class: 't-desc' }), h('div', { class: 't-use' }));
}

export function updateRail() {
  const all = [...S.sessions.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
  const working = all.filter((s) => ['working', 'unknown'].includes(effectiveSessionState(s)));
  const idle = all.filter((s) => effectiveSessionState(s) === 'idle');
  // Collapse runs of identically-titled historical sessions in one project (e.g. repeated background sessions) into one card.
  const histAll = all.filter((s) => s.state === 'historical' && inWindow(s));
  const seenT = new Map();
  const hist = [];
  for (const s of histAll) {
    const k = s.project + '|' + s.title;
    if (seenT.has(k)) { seenT.get(k).dupes++; continue; }
    const e = s; e.dupes = 0; seenT.set(k, e); hist.push(e);
  }
  const items = [];
  if (working.length) { items.push(section('working', 'Working now', working.length)); working.forEach((s) => items.push({ key: 's:' + s.id, s })); }
  else items.push({ key: 'h:none', note: true, text: 'No agents are working right now.' });
  if (idle.length) { items.push(section('idle', 'Open, idle', idle.length, 'live process, waiting for input')); idle.forEach((s) => items.push({ key: 's:' + s.id, s })); }
  const showN = S.ui.railHistory ? hist.length : Math.min(5, hist.length);
  items.push(section('hist', 'Recent history', hist.length, `not running · ${S.ui.window === 'live' ? 'last 24h' : S.ui.window === 'all' ? 'all time' : S.ui.window}`));
  hist.slice(0, showN).forEach((s) => items.push({ key: 's:' + s.id, s }));
  if (hist.length > 5) items.push({ key: 'h:more', more: true, text: S.ui.railHistory ? 'Show fewer' : `Show ${hist.length - 5} more` });
  if (!hist.length) items.push({ key: 'h:nohist', note: true, text: 'No historical sessions in this window.' });
  items.push(section('types', 'Configured agent types', S.catalog.items.length, 'definitions, not running instances'));
  for (const c of S.catalog.items) items.push({ key: 'c:' + c.name, c });
  items.push({ key: 'h:cfgnote', note: true, text: cfgNote() });

  reconcile(list, items, (i) => i.key, (i) => (i.s ? makeCard() : i.c ? makeType() : i.head ? makeHead() : h('div', { class: 'rail-note', onclick: (e) => { if (e.currentTarget.dataset.key === 'h:more') { S.ui.railHistory = !S.ui.railHistory; try { localStorage.setItem('ad.railHistory', JSON.stringify(S.ui.railHistory)); } catch { /* ignore */ } notify('rail'); } } })), (el, i) => {
    if (i.s) return updateCard(el, i.s);
    if (i.c) {
      const sel = S.ui.sel && S.ui.sel.type === 'agenttype' && S.ui.sel.id === i.c.name;
      setClass(el, `tcard${sel ? ' sel' : ''}`);
      setText(el.querySelector('.t-name'), i.c.name);
      setText(el.querySelector('.t-src'), i.c.source === 'builtin' ? 'built-in' : i.c.source);
      setText(el.querySelector('.t-desc'), (i.c.description || '').replace(/\s+/g, ' '));
      setText(el.querySelector('.t-use'), i.c.runs ? `${i.c.runs} run${i.c.runs > 1 ? 's' : ''} in transcripts · last ${ago(i.c.lastTs, S.now)}` : 'No runs seen in transcripts');
      return;
    }
    if (i.head) { setClass(el, 'rail-sec'); setText(el.querySelector('.rs-t'), i.title); setText(el.querySelector('.rs-n'), i.count); setText(el.querySelector('.rs-note'), i.note || ''); return; }
    setClass(el, 'rail-note' + (i.more ? ' link' : ''));
    setText(el, i.text);
  });
  const w = working.length, id = idle.length;
  setText(document.getElementById('rail-sub'), `${w} working · ${id} idle · ${all.length} total`);
}

function cfgNote() {
  const custom = S.catalog.items.filter((c) => c.source !== 'builtin' && c.source !== 'observed').length;
  const searched = (S.catalog.searched || []).filter((d) => d.exists).length;
  return custom ? `${custom} custom definition${custom > 1 ? 's' : ''} found on disk.` : `No custom agent definition files found (checked ~/.claude/agents, project .claude/agents folders and enabled plugins). Only Claude Code's built-in types are available to your sessions.`;
}
