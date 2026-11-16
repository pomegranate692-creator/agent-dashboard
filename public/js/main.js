import { S, subscribe, boot, setView, select, notify, effectiveSessionState } from './store.js';
import { initChrome, updateChrome } from './chrome.js';
import { initRail, updateRail } from './rail.js';
import { initMap, updateMap, mapCanvas } from './map.js';
import { initFlow, updateFlow, focusCard } from './flow.js';
import { initDetail, updateDetail } from './detail.js';
import { initFeed, updateFeed } from './feed.js';
import { $ } from './util.js';

initChrome($('#header'));
initRail($('#rail'));
initMap($('#map'));
initFlow($('#flow'));
initDetail($('#detail'));
initFeed($('#feed'));

$('#tab-map').addEventListener('click', () => setView('map'));
$('#tab-flow').addEventListener('click', () => {
  if (!(S.ui.sel && S.ui.sel.sessionId)) {
    // Open the most relevant session: a working one, else the most recently active.
    const list = [...S.sessions.values()].sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
    const pick = list.find((s) => effectiveSessionState(s) === 'working') || list[0];
    if (pick) return select({ type: 'session', sessionId: pick.id }, 'flow');
  }
  setView('flow');
});
$('#feed-open').addEventListener('click', () => { S.ui.feedOpen = true; try { localStorage.setItem('ad.feedOpen', 'true'); } catch { /* ignore */ } notify('feed'); });

let lastSelKey = null;
let pendingFocus = false;
subscribe((d) => {
  const view = S.ui.view;
  document.body.dataset.view = view;
  $('#tab-map').classList.toggle('on', view === 'map');
  $('#tab-flow').classList.toggle('on', view === 'flow');
  const sess = S.ui.sel && S.sessions.get(S.ui.sel.sessionId);
  $('#flow-label').textContent = sess ? `· ${sess.title}` : '';
  if (d.has('header') || d.has('tick')) updateChrome();
  if (d.has('rail') || d.has('tick')) updateRail();
  if (d.has('canvas') || d.has('tick')) { if (view === 'map') updateMap(); else updateFlow(); }
  if (d.has('detail') || d.has('rail')) updateDetail();
  if (d.has('feed') || d.has('tick')) updateFeed();
  const selKey = S.ui.sel ? `${S.ui.sel.sessionId}|${S.ui.sel.id}` : '';
  if (selKey !== lastSelKey) { lastSelKey = selKey; pendingFocus = !!(S.ui.sel && S.ui.sel.id); }
  if (pendingFocus && view === 'flow' && S.ui.sel) {
    const id = S.ui.sel.type === 'node' ? cardFor(S.ui.sel.id) : S.ui.sel.id;
    if (focusCard(id)) pendingFocus = false;
  }
});

// The card that contains a given node (tools live in a group card, turns in a response card).
function cardFor(id) {
  const l = S.loaded.get(S.ui.sel.sessionId);
  const n = l && l.nodes.get(id);
  if (!n) return id;
  if (n.kind === 'tool') return 'g:' + (n.parent || n.promptId);
  if (n.kind === 'turn') return 'r:' + (n.parent ? n.parent : n.promptId);
  return id;
}

window.addEventListener('hashchange', () => { /* selection is driven from the app; hash is write-mostly */ });
window.addEventListener('resize', () => notify('canvas'));

boot().then(() => {
  // Default selection when nothing is in the URL: the working session, else nothing (map stays the overview).
  if (!S.ui.sel) {
    const working = [...S.sessions.values()].find((s) => effectiveSessionState(s) === 'working');
    if (working) select({ type: 'session', sessionId: working.id });
  }
}).catch((e) => { document.body.dataset.fatal = '1'; $('#fatal').textContent = 'Could not reach the dashboard server: ' + e.message; });
