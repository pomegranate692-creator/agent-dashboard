// DOM + formatting helpers. All data is inserted via textContent / text nodes, never innerHTML.

export const $ = (sel, root = document) => root.querySelector(sel);

export function h(tag, props, ...kids) {
  const svg = tag.startsWith('svg:');
  const el = svg ? document.createElementNS('http://www.w3.org/2000/svg', tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// Keyed reconciliation: reuse existing elements so scroll position, hover and focus survive updates.
export function reconcile(parent, items, keyFn, make, update) {
  const existing = new Map();
  for (const el of Array.from(parent.children)) if (el.dataset && el.dataset.key != null) existing.set(el.dataset.key, el);
  let prev = null;
  for (const it of items) {
    const k = String(keyFn(it));
    let el = existing.get(k);
    if (!el) { el = make(it); el.dataset.key = k; } else existing.delete(k);
    if (update) update(el, it);
    const want = prev ? prev.nextSibling : parent.firstChild;
    if (el !== want) parent.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

export function setText(el, t) { t = t == null ? '' : String(t); if (el.textContent !== t) el.textContent = t; }
export function setClass(el, cls) { if (el.getAttribute('class') !== cls) el.setAttribute('class', cls); }

export const pad = (n) => String(n).padStart(2, '0');
export function fmtTime(ts) { if (!ts) return '—'; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
export function fmtDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts); const today = new Date();
  const day = d.toDateString() === today.toDateString() ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function ago(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
export function fmtNum(n) { return n == null ? '—' : n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n); }
export function fmtBytes(b) { if (b == null) return '—'; return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`; }
export function shortModel(m) { return m ? m.replace(/^claude-/, '').replace(/-\d{8}$/, '') : null; }
export function basename(p) { return p ? p.replace(/\/+$/, '').split('/').pop() || p : ''; }
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function lsGet(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } }
export function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage may be unavailable */ } }
