// Pan/zoom canvas. Viewport state persists per canvas key so reloads and re-renders don't lose your place.
import { h, clamp, lsGet, lsSet } from './util.js';

const LOW_ZOOM = 0.65;

export class Canvas {
  constructor(root, { key, minZoom = 0.12, maxZoom = 1.8, onChange } = {}) {
    this.root = root;
    this.key = 'ad.vp.' + key;
    this.minZoom = minZoom; this.maxZoom = maxZoom;
    this.onChange = onChange;
    const saved = lsGet(this.key, null);
    this.v = saved ? { x: saved.x, y: saved.y, k: saved.k } : { x: 0, y: 0, k: 1 };
    this.userMoved = !!saved;
    this.bounds = null;
    this.viewport = h('div', { class: 'viewport' });
    this.edges = h('svg:svg', { class: 'edges', width: 1, height: 1 });
    this.edges.style.overflow = 'visible';
    this.layer = h('div', { class: 'layer' });
    this.viewport.append(this.edges, this.layer);
    root.append(this.viewport);
    this.apply();
    this.bind();
  }

  apply() {
    this.viewport.style.transform = `translate(${this.v.x}px, ${this.v.y}px) scale(${this.v.k})`;
    // Semantic zoom: below this scale the map shows names and states at a readable size instead of shrunken detail.
    this.viewport.style.setProperty('--k', String(+this.v.k.toFixed(3)));
    this.root.classList.toggle('lowzoom', this.v.k < LOW_ZOOM);
  }
  save() { lsSet(this.key, this.v); }
  moved() { this.userMoved = true; this.apply(); this.save(); if (this.onChange) this.onChange(this.v); }

  bind() {
    const r = this.root;
    r.addEventListener('wheel', (e) => {
      if (e.target.closest && e.target.closest('.scrollable')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.shiftKey) {
        const rect = r.getBoundingClientRect();
        this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-(e.deltaY || e.deltaX) * (e.ctrlKey ? 0.01 : 0.0035)));
      } else { this.v.x -= e.deltaX; this.v.y -= e.deltaY; this.moved(); }
    }, { passive: false });
    let drag = null;
    r.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.card, .map-node, button, input, .toolbar, .legend')) return;
      drag = { x: e.clientX, y: e.clientY, vx: this.v.x, vy: this.v.y };
      r.setPointerCapture(e.pointerId); r.classList.add('panning');
    });
    r.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.v.x = drag.vx + e.clientX - drag.x; this.v.y = drag.vy + e.clientY - drag.y; this.moved();
    });
    const end = (e) => { if (drag) { drag = null; r.classList.remove('panning'); try { r.releasePointerCapture(e.pointerId); } catch { /* released */ } } };
    r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end);
  }

  zoomAt(px, py, factor) {
    const k = clamp(this.v.k * factor, this.minZoom, this.maxZoom);
    const f = k / this.v.k;
    this.v.x = px - (px - this.v.x) * f; this.v.y = py - (py - this.v.y) * f; this.v.k = k;
    this.moved();
  }
  zoomBy(f) { const r = this.root.getBoundingClientRect(); this.zoomAt(r.width / 2, r.height / 2, f); }

  // Switch to another saved viewport (e.g. a different session's flow).
  switchKey(key) {
    const k = 'ad.vp.' + key;
    if (k === this.key) return;
    this.key = k;
    const saved = lsGet(k, null);
    this.v = saved ? { x: saved.x, y: saved.y, k: saved.k } : { x: 0, y: 0, k: 1 };
    this.userMoved = !!saved;
    this.apply();
  }

  // anchor 'fit' shows everything; 'tail' shows the newest content (bottom-left) until the user moves the view.
  setBounds(b, anchor = 'fit') {
    this.bounds = b;
    if (this.userMoved) return;
    if (anchor === 'fit') return this.fit(false);
    const r = this.root.getBoundingClientRect();
    if (!r.width) return;
    const k = clamp((r.width - 60) / b.w, 0.55, 0.9);
    this.v.k = k;
    this.v.x = 40 - b.x * k;
    this.v.y = Math.min(70 - b.y * k, r.height - (b.y + b.h) * k - 60);
    this.apply();
  }

  fit(markMoved = true) {
    if (!this.bounds) return;
    const r = this.root.getBoundingClientRect();
    if (!r.width) return;
    const pad = 48;
    const k = clamp(Math.min((r.width - pad * 2) / this.bounds.w, (r.height - pad * 2) / this.bounds.h), this.minZoom, 1);
    this.v.k = k;
    this.v.x = (r.width - this.bounds.w * k) / 2 - this.bounds.x * k;
    this.v.y = (r.height - this.bounds.h * k) / 2 - this.bounds.y * k;
    this.apply();
    if (markMoved) { this.userMoved = true; this.save(); }
  }

  // Bring a rect (content coordinates) into view without changing zoom, only if it's outside the visible area.
  reveal(rect) {
    const r = this.root.getBoundingClientRect();
    const k = this.v.k;
    const left = rect.x * k + this.v.x, top = rect.y * k + this.v.y, right = left + rect.w * k, bottom = top + rect.h * k;
    let dx = 0, dy = 0;
    if (left < 20) dx = 20 - left; else if (right > r.width - 20) dx = r.width - 20 - right;
    if (top < 60) dy = 60 - top; else if (bottom > r.height - 20) dy = r.height - 20 - bottom;
    if (dx || dy) { this.v.x += dx; this.v.y += dy; this.moved(); }
  }
  focus(rect) {
    const r = this.root.getBoundingClientRect();
    const k = Math.max(this.v.k, 0.6);
    this.v.k = Math.min(k, 1);
    this.v.x = r.width / 2 - (rect.x + rect.w / 2) * this.v.k;
    this.v.y = r.height / 2 - (rect.y + rect.h / 2) * this.v.k;
    this.moved();
  }
}
