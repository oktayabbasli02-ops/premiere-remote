// Video surface: letterboxed <video> (object-fit: contain) with pinch-zoom/pan via a CSS transform
// (origin 0 0, translate(pan) scale(s)) — exactly the transform shared/mapping.js inverts:
// screen = base * scale + pan. Touch gestures become remote input; same gestures as Android:
//   Touch:    tap = click · hold = right-click · drag = mouse drag · two fingers = zoom/pan view
//   Trackpad: move = relative cursor · tap = click · two-finger tap = right-click ·
//             two-finger drag = scroll · hold then move = drag · pinch = zoom view

import { viewToNormalized, clampPan as clampPanOnly } from '../shared/mapping.js';

const SLOP = 8;
// shared clampPan returns only {scale, panX, panY}; keep the view/frame dimensions
const clampPan = (v) => ({ ...v, ...clampPanOnly(v) });

export class RemoteSurface {
  /** @param {HTMLElement} box @param {HTMLVideoElement} video */
  constructor(box, video) {
    this.box = box;
    this.video = video;
    this.input = null; // { move(p), rel(dx,dy), ptr(kind, p, button, dy) }
    this.trackpad = false;
    this.enabled = false;
    this.view = { viewW: 1, viewH: 1, frameW: 16, frameH: 9, scale: 1, panX: 0, panY: 0 };
    video.addEventListener('resize', () => this.relayout());
    new ResizeObserver(() => this.relayout()).observe(box);
    box.addEventListener('touchstart', (e) => this.onStart(e), { passive: false });
    box.addEventListener('touchmove', (e) => this.onMove(e), { passive: false });
    box.addEventListener('touchend', (e) => this.onEnd(e), { passive: false });
    box.addEventListener('touchcancel', (e) => this.onCancel(e), { passive: false });
    // desktop browsers (testing): mouse acts like a single finger
    box.addEventListener('mousedown', (e) => this.onStart(fakeTouch(e)));
    window.addEventListener('mousemove', (e) => { if (this.mouseDown) this.onMove(fakeTouch(e)); });
    window.addEventListener('mouseup', (e) => { if (this.mouseDown) this.onEnd(fakeTouch(e, true)); });
    box.addEventListener('mousedown', () => { this.mouseDown = true; });
    window.addEventListener('mouseup', () => { this.mouseDown = false; });
    box.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  relayout() {
    const r = this.box.getBoundingClientRect();
    this.view = clampPan({ ...this.view, viewW: r.width, viewH: r.height, frameW: this.video.videoWidth || 16, frameH: this.video.videoHeight || 9 });
    this.apply();
  }

  apply() {
    const { scale, panX, panY } = this.view;
    this.video.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
  }

  resetZoom() {
    this.view = clampPan({ ...this.view, scale: 1, panX: 0, panY: 0 });
    this.apply();
  }

  local(t) {
    const r = this.box.getBoundingClientRect();
    return { x: t.clientX - r.left, y: t.clientY - r.top };
  }

  map(p) {
    return viewToNormalized(p.x, p.y, this.view);
  }

  onStart(e) {
    e.preventDefault?.();
    const ts = e.touches;
    if (ts.length === 1) {
      this.g = { start: this.local(ts[0]), last: this.local(ts[0]), at: performance.now(), dragging: false, longFired: false, multi: false };
      clearTimeout(this.longTimer);
      this.longTimer = setTimeout(() => this.onLong(), this.trackpad ? 350 : 550);
    } else if (ts.length === 2 && this.g) {
      clearTimeout(this.longTimer);
      if (this.g.dragging && this.enabled) this.input?.ptr('up', this.trackpad ? null : this.map(this.g.last));
      this.g.dragging = false;
      this.g.multi = true;
      this.g.twoMoved = false;
      this.g.pinch = this.two(ts);
      this.g.scroll = 0;
    }
  }

  two(ts) {
    const a = this.local(ts[0]);
    const b = this.local(ts[1]);
    return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  onLong() {
    const g = this.g;
    if (!g || g.multi || g.dragging) return;
    g.longFired = true;
    navigator.vibrate?.(20);
    if (!this.enabled) return;
    if (this.trackpad) {
      g.dragging = true;
      this.input?.ptr('down', null);
    } else {
      const p = this.map(g.start);
      if (p) this.input?.ptr('click', p, 'right');
    }
  }

  onMove(e) {
    e.preventDefault?.();
    const g = this.g;
    if (!g) return;
    const ts = e.touches;
    if (g.multi && ts.length >= 2) {
      const now = this.two(ts);
      const prev = g.pinch;
      const f = now.d / Math.max(prev.d, 1);
      const pinching = Math.abs(f - 1) > 0.01;
      if (Math.hypot(now.cx - prev.cx, now.cy - prev.cy) > 1 || pinching) g.twoMoved = true;
      if (this.trackpad && !pinching && this.enabled) {
        g.scroll += now.cy - prev.cy;
        if (Math.abs(g.scroll) > 24) { this.input?.ptr('scroll', null, 'left', Math.round(g.scroll * -5)); g.scroll = 0; }
      } else {
        const s = Math.min(8, Math.max(1, this.view.scale * f));
        const k = s / this.view.scale;
        // zoom about the pinch centre, then follow the centre's movement
        this.view = clampPan({
          ...this.view, scale: s,
          panX: now.cx - (prev.cx - this.view.panX) * k,
          panY: now.cy - (prev.cy - this.view.panY) * k,
        });
        this.apply();
      }
      g.pinch = now;
      return;
    }
    if (g.multi) return;
    const p = this.local(ts[0]);
    const moved = Math.hypot(p.x - g.start.x, p.y - g.start.y) > SLOP;
    if (moved && !g.longFired) clearTimeout(this.longTimer);
    if (!this.enabled) { g.last = p; return; }
    if (this.trackpad) {
      if (moved || g.dragging) {
        const dx = p.x - g.last.x;
        const dy = p.y - g.last.y;
        const sp = Math.hypot(dx, dy);
        const acc = (sp < 3 ? 0.6 : sp < 12 ? 1.2 : 2.2) / this.view.scale;
        this.input?.rel((dx / this.view.viewW) * acc, (dy / this.view.viewH) * acc);
      }
    } else if (!g.longFired) {
      if (moved && !g.dragging) {
        const s = this.map(g.start);
        if (s) { g.dragging = true; this.input?.ptr('down', s); }
      }
      if (g.dragging) {
        const n = this.map(p);
        if (n) this.input?.move(n);
      }
    }
    g.last = p;
  }

  onEnd(e) {
    e.preventDefault?.();
    const g = this.g;
    if (!g) return;
    if (e.touches.length > 0) {
      // second finger lifted: two-finger tap in trackpad mode = right click
      if (this.trackpad && g.multi && !g.twoMoved && this.enabled && performance.now() - g.at < 350) {
        this.input?.ptr('click', null, 'right');
        g.twoMoved = true;
      }
      return;
    }
    clearTimeout(this.longTimer);
    this.g = null;
    if (!this.enabled || g.multi) return;
    const end = e.changedTouches?.[0] ? this.local(e.changedTouches[0]) : g.last;
    if (g.dragging) {
      this.input?.ptr('up', this.trackpad ? null : this.map(end));
    } else if (!g.longFired && Math.hypot(end.x - g.start.x, end.y - g.start.y) <= SLOP) {
      // two quick taps arrive as two clicks; Windows turns them into a double-click
      if (this.trackpad) this.input?.ptr('click', null);
      else { const p = this.map(end); if (p) this.input?.ptr('click', p); }
    }
  }

  onCancel() {
    clearTimeout(this.longTimer);
    if (this.g?.dragging && this.enabled) this.input?.ptr('up', this.trackpad ? null : this.map(this.g.last));
    this.g = null;
  }
}

function fakeTouch(e, ended = false) {
  const t = { clientX: e.clientX, clientY: e.clientY };
  return { touches: ended ? [] : [t], changedTouches: [t], preventDefault: () => {} };
}
