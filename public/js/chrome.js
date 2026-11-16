// Header: connection status, live counters, attention list, and the "how this is observed" panel.
import { h, setText, setClass, ago, fmtTime, fmtDateTime, fmtNum, reconcile } from './util.js';
import { S, effectiveSessionState, attentionItems, unseen, markSeen, select, notify } from './store.js';

let root, pop = null, popEl = null;

export function initChrome(el) {
  root = el;
  root.append(
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), h('span', { class: 'name' }, 'Agent Dashboard'), h('span', { class: 'tag' }, 'read-only')),
    h('div', { class: 'conn', id: 'conn' }, h('span', { class: 'dot' }), h('span', { class: 'conn-t' })),
    h('div', { class: 'chip-fixture hidden', id: 'fixture' }, 'FIXTURE DATA — not your real ~/.claude'),
    h('div', { class: 'stats', id: 'stats' }),
    h('span', { class: 'grow' }),
    h('button', { class: 'hbtn', id: 'btn-attn', onclick: () => toggle('attn') }, 'Needs attention ', h('b', { id: 'attn-n' }, '0')),
    h('button', { class: 'hbtn', id: 'btn-src', onclick: () => toggle('src') }, 'How this is observed'));
  popEl = h('div', { class: 'popover hidden', id: 'popover' });
  document.body.append(popEl);
  document.addEventListener('pointerdown', (e) => { if (pop && !e.target.closest('#popover, .hbtn')) { pop = null; renderPop(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) { pop = null; renderPop(); } });
}

function toggle(k) { pop = pop === k ? null : k; renderPop(); }

function stat(label, n, cls, title) {
  return h('div', { class: `stat ${cls || ''}`, title }, h('b', {}, String(n)), h('span', {}, label));
}

export function updateChrome() {
  const sess = [...S.sessions.values()];
  const w = sess.filter((s) => effectiveSessionState(s) === 'working').length;
  const i = sess.filter((s) => effectiveSessionState(s) === 'idle').length;
  const subRun = sess.filter((s) => effectiveSessionState(s) === 'working').reduce((a, s) => a + s.subagents.filter((u) => u.status === 'pending' || u.status === 'async').length, 0);
  const att = unseen(attentionItems());
  const conn = document.getElementById('conn');
  const idx = S.health && S.health.indexing;
  const label = idx ? `Indexing history ${S.health.indexed}/${S.health.indexTotal}` : S.conn === 'live' ? 'Live · observing' : S.conn === 'lost' ? `Visibility lost ${ago(S.lostSince, S.now)}` : 'Connecting…';
  setClass(conn, `conn ${idx ? 'connecting' : S.conn}`);
  setText(conn.querySelector('.conn-t'), label);
  conn.querySelector('.dot').setAttribute('class', `dot ${idx ? 'unknown' : S.conn === 'live' ? 'working' : S.conn === 'lost' ? 'error' : 'unknown'}`);
  document.getElementById('fixture').classList.toggle('hidden', S.realRoot !== false);
  const stats = document.getElementById('stats');
  const sig = `${w}|${i}|${subRun}|${S.conn}`;
  if (stats.dataset.sig !== sig) {
    stats.dataset.sig = sig; stats.textContent = '';
    stats.append(stat('working', w, w ? 'working' : '', 'Sessions whose registered process reports status busy'), stat('idle', i, '', 'Open sessions waiting for input'), stat('subagents running', subRun, subRun ? 'working' : '', 'Subagent runs with no result yet, inside working sessions'));
  }
  setText(document.getElementById('attn-n'), att.length);
  document.getElementById('btn-attn').classList.toggle('has', att.length > 0);
  document.getElementById('lostbar').classList.toggle('hidden', S.conn === 'live' || (S.health && S.health.indexing) || S.conn === 'connecting');
  setText(document.getElementById('lostbar'), `Visibility lost since ${fmtTime(S.lostSince)}. The dashboard cannot see your agents right now; sessions shown as “Unknown” may still be working or may have finished. Reconnecting automatically…`);
  if (pop) renderPop();
}

function place() {
  const btn = document.getElementById(pop === 'attn' ? 'btn-attn' : 'btn-src');
  const r = btn.getBoundingClientRect();
  popEl.style.top = r.bottom + 8 + 'px';
  popEl.style.right = Math.max(12, window.innerWidth - r.right) + 'px';
}

function renderPop() {
  popEl.classList.toggle('hidden', !pop);
  popEl.classList.toggle('wide', pop === 'src');
  if (!pop) return;
  place();
  popEl.textContent = '';
  if (pop === 'attn') {
    const items = attentionItems();
    popEl.append(h('div', { class: 'pop-head' }, h('b', {}, 'Needs attention'), h('span', { class: 'grow' }), h('button', { class: 'btn sm', onclick: () => markSeen(items.map((a) => a.id)) }, 'Mark all seen')),
      h('div', { class: 'pop-note' }, 'Waiting-for-you prompts and failed or blocked tool calls from the last 24h. “Seen” is only remembered in this browser.'));
    if (!items.length) popEl.append(h('div', { class: 'pop-empty' }, 'Nothing needs attention.'));
    popEl.append(h('div', { class: 'alist pop-list scrollable' }, ...items.slice(0, 60).map((a) => {
      const s = S.sessions.get(a.sessionId);
      return h('div', { class: `arow ${a.level}${S.seen.has(a.id) ? ' seen' : ''}`, onclick: () => { markSeen([a.id]); pop = null; renderPop(); select({ type: 'node', sessionId: a.sessionId, id: a.nodeId }, 'flow'); } },
        h('span', { class: 'at' }, fmtTime(a.ts)), h('span', { class: 'atx' }, `${s ? s.title + ' — ' : ''}${a.text}`));
    })));
  } else {
    const hl = S.health || {};
    const reg = hl.registry || {};
    const dirs = (S.catalog.searched || []);
    popEl.append(
      h('div', { class: 'pop-head' }, h('b', {}, 'How this is observed')),
      h('div', { class: 'src-grid' },
        srcRow(hl.lastScanError ? 'error' : 'ok', 'Session transcripts', `${hl.files ?? '—'} files · ${S.sessions.size} sessions · last scan ${ago(hl.lastScanTs, S.now)}${hl.parseErrors ? ` · ${hl.parseErrors} unreadable lines skipped` : ''}`, `${S.root}/projects/**/*.jsonl, and …/subagents/agent-*.jsonl`),
        srcRow(reg.ok ? 'ok' : 'error', 'Live-session registry', reg.ok ? `${reg.entries} entries · ${reg.alive} with a running process · read ${ago(reg.ts, S.now)}` : `unreadable: ${reg.error}`, `${S.root}/sessions/*.json — decides working / idle / not running`),
        srcRow(S.conn === 'live' ? 'ok' : 'error', 'Dashboard ↔ server stream', S.conn === 'live' ? 'connected (server-sent events)' : `lost ${ago(S.lostSince, S.now)}`, 'Changes arrive within about a second of Claude Code writing them'),
        srcRow('ok', 'Agent definitions', `${S.catalog.items.filter((c) => c.source !== 'builtin' && c.source !== 'observed').length} custom found · ${S.catalog.items.length} types known`, dirs.map((d) => `${d.exists ? '✓' : '✗'} ${d.dir}`).slice(0, 8).join('\n'))),
      h('div', { class: 'pop-sub' }, 'What this does and does not show'),
      h('ul', { class: 'lims' },
        h('li', {}, 'Strictly read-only. Nothing is written to ~/.claude, no hooks are installed, no agent is started, steered or stopped.'),
        h('li', {}, '“Working” / “Idle” come from the registry entry and its process id. A session with no running process is shown as “Not running” — never inferred as finished or failed.'),
        h('li', {}, 'A tool call with no result is “Running” only while its session is registered as working. Otherwise it reads “No result recorded”.'),
        h('li', {}, 'Transcripts are written a moment after events happen, so the view can lag a few seconds. A pending permission prompt can’t be seen; only questions Claude asked you (AskUserQuestion / ExitPlanMode) are flagged.'),
        h('li', {}, 'Private reasoning blocks are never read or shown. Obvious secrets (API keys, tokens) are masked in previews and detail views.'),
        h('li', {}, 'Sessions run by tools that don’t write to ~/.claude (e.g. cloud sessions, other machines) are invisible here.')));
  }
}

function srcRow(st, title, text, tip) {
  return h('div', { class: 'src', title: tip }, h('span', { class: `dot ${st === 'ok' ? 'working' : 'error'}` }), h('div', {}, h('div', { class: 'src-t' }, title), h('div', { class: 'src-x' }, text)));
}
