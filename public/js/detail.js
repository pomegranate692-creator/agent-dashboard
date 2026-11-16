// Right-hand inspector. Overview stays short; long output lives here, fetched on demand from the transcript.
import { h, setText, fmtDateTime, fmtTime, fmtDur, fmtNum, fmtBytes, ago, shortModel } from './util.js';
import { S, effectiveSessionState, nodeState, subState, STATE_LABEL, select, notify, attentionItems, markSeen, sessionNodes } from './store.js';
import { buildModel, groupMembers } from './flow.js';

let root, body, lastSig = '';

export function initDetail(el) {
  root = el;
  body = h('div', { class: 'detail-body scrollable' });
  root.append(h('div', { class: 'detail-head' }, h('h2', {}, 'Inspector')), body);
}

const kv = (k, v, title) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v', title }, v == null || v === '' ? '—' : v));
const pill = (st) => h('span', { class: `pill ${st}` }, STATE_LABEL[st] || st);
const note = (t, cls = '') => h('div', { class: 'note ' + cls }, t);
const sec = (title, ...kids) => h('section', { class: 'dsec' }, h('h3', {}, title), ...kids);

function codeBlock(title, s) {
  const wrap = h('div', { class: 'codewrap' });
  const pre = h('pre', { class: 'code' }, s.text || '(empty)');
  const actions = h('div', { class: 'code-actions' },
    h('button', { class: 'btn sm', onclick: (e) => { navigator.clipboard && navigator.clipboard.writeText(s.text).then(() => { e.target.textContent = 'Copied'; setTimeout(() => { e.target.textContent = 'Copy'; }, 1200); }); } }, 'Copy'),
    h('button', { class: 'btn sm', onclick: (e) => { pre.classList.toggle('open'); e.target.textContent = pre.classList.contains('open') ? 'Collapse' : 'Expand'; } }, 'Expand'));
  wrap.append(h('div', { class: 'code-title' }, h('span', {}, title), h('span', { class: 'code-meta' }, `${fmtNum(s.fullLength)} chars`), actions), pre);
  if (s.truncated) wrap.append(note(`Output truncated to the first ${fmtNum(s.text.length)} of ${fmtNum(s.fullLength)} characters.`, 'warn'));
  return wrap;
}

function fetchDetail(sessionId, node) {
  const key = `${sessionId}|${node.id}|${node.status || ''}|${node.endTs || ''}|${node.textChars || ''}`;
  const hit = S.details.get(key);
  if (hit) return hit;
  S.details.set(key, { loading: true });
  fetch(`/api/node?session=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(node.id)}`).then((r) => r.json()).then((d) => { S.details.set(key, d); notify('detail'); }).catch(() => { S.details.set(key, { error: true }); notify('detail'); });
  return S.details.get(key);
}

function detailSections(sessionId, node) {
  const d = fetchDetail(sessionId, node);
  if (d.loading) return [note('Loading full content from the transcript…')];
  if (d.error) return [note('Could not read this record from the transcript (file moved or unreadable).', 'warn')];
  return (d.sections || []).filter((s) => s.text !== '' || true).map((s) => codeBlock(s.title, s));
}

function timeFacts(n, sess, atTs) {
  const out = [kv('Started', fmtDateTime(n.ts))];
  if (n.endTs) out.push(kv('Finished', fmtDateTime(n.endTs)), kv('Duration', fmtDur(n.durationMs != null ? n.durationMs : n.endTs - n.ts)));
  return out;
}

export function updateDetail() {
  const sel = S.ui.sel;
  const scroll = body.scrollTop;
  const sig = JSON.stringify([sel, S.conn, sel && sel.sessionId ? sessionSig(sel.sessionId) : '', S.catalog.items.length, [...S.details.keys()].length, S.seen.size]);
  if (sig === lastSig) return;
  lastSig = sig;
  const kids = render(sel);
  body.textContent = '';
  body.append(...kids);
  body.scrollTop = scroll;
}

function sessionSig(id) {
  const s = S.sessions.get(id);
  const l = S.loaded.get(id);
  return [s && s.state, s && s.lastTs, s && s.counts.tools, s && s.counts.prompts, s && s.subagentTotal, s && s.openToolTotal, l && l.nodes.size, l && [...l.nodes.values()].filter((n) => n.status === 'pending').length].join('|');
}

function render(sel) {
  if (!sel) return [h('div', { class: 'empty' }, h('p', {}, 'Select an agent, session, subagent or activity row to inspect it.'), h('p', { class: 'dim' }, 'Nothing is selected, so nothing is shown. Long outputs, full prompts and errors appear here rather than in the overview.'))];
  if (sel.type === 'agenttype') return renderType(sel.id);
  const sess = S.sessions.get(sel.sessionId);
  if (!sess) return [note('This session is not in the current index.')];
  if (sel.type === 'session' || !sel.id) return renderSession(sess);
  const nodes = sessionNodes(sess.id);
  if (!nodes) return [note('Loading session…')];
  if (sel.type === 'group') return renderGroup(sess, nodes, sel);
  const n = nodes.get(sel.id);
  if (!n) return [back(sess), note('That record is not loaded (it may be older than the loaded window — use "Load all" in the flow view).')];
  return renderNode(sess, nodes, n);
}

function back(sess) { return h('button', { class: 'crumb link', onclick: () => select({ type: 'session', sessionId: sess.id }) }, `◂ ${sess.title}`); }

function renderSession(s) {
  const eff = effectiveSessionState(s);
  const kids = [];
  kids.push(h('div', { class: 'd-title' }, h('span', { class: `dot ${eff}` }), h('span', {}, s.title)), h('div', { class: 'd-sub' }, 'Session · ', pill(eff)));
  kids.push(h('div', { class: 'cta' }, h('button', { class: 'btn primary', onclick: () => select({ type: 'session', sessionId: s.id }, 'flow') }, 'Open flow ▸')));
  const evidence = s.live
    ? `Registered live process (pid ${s.live.pid}), status “${s.live.status}”, updated ${ago(s.live.statusUpdatedAt, S.now)}.`
    : `No live process is registered for this session, so nothing is running. Last transcript activity ${ago(s.lastTs, S.now)}.`;
  kids.push(note(S.conn !== 'live' ? `Visibility lost since ${fmtTime(S.lostSince)}; state below is the last known. ${evidence}` : evidence, S.conn !== 'live' ? 'warn' : ''));
  if (s.awaitingUser) kids.push(sec('Waiting for you', note(`${s.awaitingUser.name}: ${s.awaitingUser.input || ''}`, 'ask'), h('button', { class: 'btn', onclick: () => select({ type: 'node', sessionId: s.id, id: s.awaitingUser.id }, 'flow') }, 'Inspect')));
  const items = attentionItems().filter((a) => a.sessionId === s.id && a.kind !== 'awaiting');
  if (items.length) {
    kids.push(sec(`Failures & warnings (24h) · ${items.length}`, h('div', { class: 'alist' }, ...items.slice(0, 12).map((a) => h('div', { class: `arow ${a.level}${S.seen.has(a.id) ? ' seen' : ''}`, onclick: () => { markSeen([a.id]); select({ type: 'node', sessionId: s.id, id: a.nodeId }, 'flow'); } }, h('span', { class: 'at' }, fmtTime(a.ts)), h('span', { class: 'atx' }, a.text))))));
  }
  if (eff === 'working' && s.openTools.length) {
    kids.push(sec(`In progress (${s.openToolTotal})`, h('div', { class: 'alist' }, ...s.openTools.map((t) => h('div', { class: 'arow', onclick: () => select({ type: 'node', sessionId: s.id, id: t.id }, 'flow') }, h('span', { class: 'at' }, ago(t.ts, S.now)), h('span', { class: 'atx' }, `${t.name}${t.input ? ' — ' + t.input : ''}`))))));
  }
  if (s.subagents.length) {
    kids.push(sec(`Subagents (${s.subagentTotal})`, h('div', { class: 'alist' }, ...s.subagents.slice(0, 30).map((u) => {
      const st = subState(u, s);
      return h('div', { class: 'arow', onclick: () => select({ type: 'node', sessionId: s.id, id: u.id }, 'flow') }, h('span', { class: `dot ${st}` }), h('span', { class: 'atx' }, `${u.agentType || 'agent'} — ${u.description || ''}`), h('span', { class: 'at' }, STATE_LABEL[st]));
    }))));
  }
  kids.push(sec('Details',
    kv('Project', s.project, s.cwd), kv('Session ID', s.id), kv('Started', fmtDateTime(s.firstTs)), kv('Last activity', fmtDateTime(s.lastTs)),
    kv('Entry point', s.entrypoint), kv('Claude Code', s.version ? 'v' + s.version : null), kv('Models seen', s.models.map(shortModel).join(', ')),
    kv('Prompts', fmtNum(s.counts.prompts)), kv('Tool calls', `${fmtNum(s.counts.tools)} (${s.counts.errors} failed, ${s.counts.denied} blocked)`), kv('API errors', s.counts.apiErrors),
    kv('Transcript', s.transcript ? fmtBytes(s.transcript.bytes) : null), kv('Title from', s.titleSource)));
  return kids;
}

function renderNode(sess, nodes, n) {
  const kids = [back(sess)];
  const st = nodeState(n, sess);
  if (n.kind === 'prompt') {
    kids.push(h('div', { class: 'd-title' }, h('span', { class: 'kind-chip prompt' }, 'PROMPT'), h('span', {}, n.text)), h('div', { class: 'd-sub' }, fmtDateTime(n.ts), n.origin && n.origin !== 'human' ? ` · from ${n.origin}` : ' · you'));
    kids.push(...detailSections(sess.id, n));
    const m = buildModel(nodes);
    const r = m.prompts.find((x) => x.p.id === n.id);
    if (r) kids.push(sec('What followed', kv('Claude steps', r.turns.length), kv('Tool calls', r.tools.length), kv('Subagents started', r.subs.length)));
  } else if (n.kind === 'tool') {
    kids.push(h('div', { class: 'd-title' }, h('span', { class: 'kind-chip tool' }, 'TOOL'), h('span', {}, n.name)), h('div', { class: 'd-sub' }, pill(st), n.scope !== 'main' ? ' · inside a subagent' : ''));
    if (st === 'unresolved') kids.push(note('No result was ever recorded for this call. The session is not currently running it.', 'warn'));
    if (st === 'denied') kids.push(note('Claude Code blocked this call through its permission system; it did not run.', 'warn'));
    if (st === 'rejected') kids.push(note('This call was declined at a permission prompt.', 'warn'));
    kids.push(sec('Timing', ...timeFacts(n, sess), kv('Call ID', n.id)));
    kids.push(...detailSections(sess.id, n));
  } else if (n.kind === 'subagent') {
    kids.push(h('div', { class: 'd-title' }, h('span', { class: 'kind-chip sub' }, 'SUBAGENT'), h('span', {}, n.agentType || 'agent')), h('div', { class: 'd-sub' }, pill(st), ' · ', n.description || ''));
    if (st === 'unresolved') kids.push(note('The parent never recorded a result for this subagent and its session is not running. Whether it finished is unknown.', 'warn'));
    const stats = n.stats || {};
    const m = buildModel(nodes);
    const s = m.subs.get(n.id);
    kids.push(h('div', { class: 'cta' }, h('button', { class: 'btn primary', onclick: () => { select({ type: 'node', sessionId: sess.id, id: n.id }, 'flow'); notify('canvas'); } }, 'Show in flow ▸')));
    kids.push(sec('Run', kv('Type', n.agentType), kv('Spawned', fmtDateTime(n.ts)), kv('Returned', n.endTs ? fmtDateTime(n.endTs) : null), kv('Duration (reported)', stats.durationMs != null ? fmtDur(stats.durationMs) : null),
      kv('Tokens (reported)', stats.totalTokens != null ? fmtNum(stats.totalTokens) : null), kv('Tool calls (reported)', stats.toolUses), kv('Model', shortModel(stats.model || n.model)), kv('Background', n.background ? 'yes' : 'no'),
      kv('Agent ID', n.agentId), kv('Linked by', 'parent Agent tool_use ' + n.toolUseId.slice(0, 14) + '…', n.toolUseId), kv('Transcript', n.hasTranscript ? 'subagent transcript found' : 'no subagent transcript file found')));
    kids.push(...detailSections(sess.id, n));
    if (s && s.tools.length) kids.push(sec(`Its tool calls (${s.tools.length})`, toolList(sess, s.tools)));
  } else if (n.kind === 'turn') {
    kids.push(h('div', { class: 'd-title' }, h('span', { class: 'kind-chip resp' }, 'CLAUDE'), h('span', {}, shortModel(n.model) || '')), h('div', { class: 'd-sub' }, fmtDateTime(n.ts)));
    kids.push(...detailSections(sess.id, n));
    const u = n.usage;
    if (u) kids.push(sec('Tokens (as reported in the transcript)', kv('Input', fmtNum(u.input)), kv('Output', fmtNum(u.output)), kv('Cache read', fmtNum(u.cacheRead)), kv('Cache write', fmtNum(u.cacheCreate))));
  } else if (n.kind === 'event') {
    kids.push(h('div', { class: 'd-title' }, h('span', { class: 'kind-chip err' }, n.subtype === 'api_error' ? 'API ERROR' : 'EVENT'), h('span', {}, n.text)), h('div', { class: 'd-sub' }, fmtDateTime(n.ts), n.detail ? ' · ' + n.detail : ''));
    kids.push(note(n.subtype === 'api_error' ? 'Claude Code reported an API error and retried. This is recorded in the session transcript.' : 'Recorded in the session transcript.'));
  }
  return kids;
}

function toolList(sess, tools) {
  return h('div', { class: 'alist' }, ...tools.map((t) => {
    const st = nodeState(t, sess);
    return h('div', { class: `arow ${st === 'error' ? 'error' : st === 'denied' ? 'warn' : ''}`, onclick: () => select({ type: 'node', sessionId: sess.id, id: t.id }) },
      h('span', { class: `dot ${st}` }), h('span', { class: 'at' }, fmtTime(t.ts)), h('span', { class: 'atx' }, `${t.name}${t.input ? ' — ' + t.input : ''}`), h('span', { class: 'at' }, t.durationMs != null ? fmtDur(t.durationMs) : STATE_LABEL[st]));
  }));
}

function renderGroup(sess, nodes, sel) {
  const m = buildModel(nodes);
  const g = groupMembers(m, sel.id);
  const kids = [back(sess)];
  if (!g) return [...kids, note('That group is not loaded.')];
  if (g.kind === 'tools') {
    const owner = g.owner;
    const items = sel.filter ? g.items.filter((t) => t.name === sel.filter) : g.items;
    kids.push(h('div', { class: 'd-title' }, h('span', { class: 'kind-chip tool' }, 'TOOL CALLS'), h('span', {}, sel.filter ? `${sel.filter} (${items.length} of ${g.items.length})` : `${items.length} calls`)),
      h('div', { class: 'd-sub' }, owner.kind === 'prompt' ? `for prompt: ${owner.text}` : `by subagent: ${owner.description || owner.agentType}`));
    if (sel.filter) kids.push(h('button', { class: 'btn', onclick: () => select({ type: 'group', sessionId: sess.id, id: sel.id }) }, 'Show all tools'));
    kids.push(toolList(sess, items));
  } else {
    kids.push(h('div', { class: 'd-title' }, h('span', { class: 'kind-chip resp' }, 'CLAUDE'), h('span', {}, `${g.items.length} step${g.items.length === 1 ? '' : 's'} for this prompt`)), h('div', { class: 'd-sub' }, `prompt: ${g.owner.text}`));
    kids.push(h('div', { class: 'alist' }, ...g.items.map((t) => h('div', { class: 'arow', onclick: () => select({ type: 'node', sessionId: sess.id, id: t.id }) }, h('span', { class: 'at' }, fmtTime(t.ts)), h('span', { class: 'atx' }, t.preview || `(${t.toolIds.length} tool call${t.toolIds.length === 1 ? '' : 's'}, no text)`)))));
    if (g.events && g.events.length) kids.push(sec('Events', ...g.events.map((e) => note(`${fmtTime(e.ts)} · ${e.text}`, 'warn'))));
  }
  return kids;
}

function renderType(name) {
  const c = S.catalog.items.find((x) => x.name === name);
  if (!c) return [note('Unknown agent type.')];
  const kids = [h('div', { class: 'd-title' }, h('span', { class: 'kind-chip sub' }, 'AGENT TYPE'), h('span', {}, c.name)), h('div', { class: 'd-sub' }, 'Configured definition — not a running instance')];
  kids.push(note(c.source === 'builtin' ? 'Built-in to Claude Code. Listed to your sessions by the harness; there is no definition file on your machine to edit.' : c.source === 'observed' ? 'Seen running in transcripts, but no definition (built-in listing or file) was found for it.' : 'Defined by a file on disk.'));
  if (c.description) kids.push(sec('Description (as listed to sessions)', h('div', { class: 'prose' }, c.description)));
  kids.push(sec('Configuration', kv('Source', c.sourceLabel), kv('Tools', c.tools), kv('Model', c.model), kv('File', c.path)));
  const inst = [];
  for (const s of S.sessions.values()) for (const u of s.subagents) if ((u.agentType || '(unspecified)') === c.name) inst.push({ s, u });
  inst.sort((a, b) => (b.u.ts || 0) - (a.u.ts || 0));
  kids.push(sec(`Runs seen in transcripts (${c.runs})`, inst.length ? h('div', { class: 'alist' }, ...inst.slice(0, 25).map(({ s, u }) => { const st = subState(u, s); return h('div', { class: 'arow', onclick: () => select({ type: 'node', sessionId: s.id, id: u.id }, 'flow') }, h('span', { class: `dot ${st}` }), h('span', { class: 'atx' }, `${u.description || ''} — ${s.title}`), h('span', { class: 'at' }, ago(u.ts, S.now))); })) : note('No runs of this type found in the transcripts on this machine.')));
  return kids;
}
