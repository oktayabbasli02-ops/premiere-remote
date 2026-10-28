import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRect, viewToNormalized, normalizedToScreen, clampPan, dipToPhysical } from '../src/mapping.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('fitRect letterboxes a 16:9 frame in a portrait phone view', () => {
  const r = fitRect(1080, 2340, 1280, 720);
  close(r.w, 1080);
  close(r.h, 607.5);
  close(r.x, 0);
  close(r.y, (2340 - 607.5) / 2);
});

test('fitRect pillarboxes a 16:9 frame in an ultra-wide landscape view', () => {
  const r = fitRect(2400, 1080, 1920, 1080);
  close(r.h, 1080);
  close(r.w, 1920);
  close(r.x, 240);
});

test('viewToNormalized maps centre and corners without zoom', () => {
  const v = { viewW: 1080, viewH: 2340, frameW: 1280, frameH: 720 };
  const top = (2340 - 607.5) / 2;
  assert.deepEqual(viewToNormalized(540, 2340 / 2, v), { x: 0.5, y: 0.5 });
  const tl = viewToNormalized(0, top, v);
  close(tl.x, 0); close(tl.y, 0);
  const br = viewToNormalized(1080, top + 607.5, v);
  close(br.x, 1); close(br.y, 1);
});

test('viewToNormalized returns null for taps in the letterbox bars', () => {
  const v = { viewW: 1080, viewH: 2340, frameW: 1280, frameH: 720 };
  assert.equal(viewToNormalized(540, 10, v), null);
  assert.equal(viewToNormalized(540, 2330, v), null);
});

test('viewToNormalized honours pinch zoom and pan', () => {
  // landscape view exactly matching the frame aspect, zoomed 2x and panned to show the bottom-right quarter
  const v = { viewW: 1600, viewH: 900, frameW: 1280, frameH: 720, scale: 2, panX: -1600, panY: -900 };
  const p = viewToNormalized(0, 0, v);
  close(p.x, 0.5); close(p.y, 0.5);
  const q = viewToNormalized(1600, 900, v);
  close(q.x, 1); close(q.y, 1);
});

test('normalized coordinates are invariant under device rotation', () => {
  const portrait = { viewW: 1080, viewH: 2340, frameW: 1920, frameH: 1080 };
  const landscape = { viewW: 2340, viewH: 1080, frameW: 1920, frameH: 1080 };
  const pr = fitRect(portrait.viewW, portrait.viewH, 1920, 1080);
  const lr = fitRect(landscape.viewW, landscape.viewH, 1920, 1080);
  // same relative point (25%, 75%) of the picture in both orientations
  const a = viewToNormalized(pr.x + pr.w * 0.25, pr.y + pr.h * 0.75, portrait);
  const b = viewToNormalized(lr.x + lr.w * 0.25, lr.y + lr.h * 0.75, landscape);
  close(a.x, b.x); close(a.y, b.y);
});

test('clampPan keeps zoomed content covering the view and centres unzoomed content', () => {
  const v = { viewW: 1600, viewH: 900, frameW: 1280, frameH: 720 };
  const c = clampPan({ ...v, scale: 2, panX: 500, panY: -5000 });
  assert.equal(c.panX, 0);      // cannot drag the left edge into view
  assert.equal(c.panY, -900);   // cannot drag past the bottom edge
  const u = clampPan({ ...v, scale: 1, panX: 300, panY: 300 });
  assert.equal(u.panX, 0);
  assert.equal(u.panY, 0);
  assert.equal(clampPan({ ...v, scale: 50 }).scale, 8);
});

test('normalizedToScreen maps to physical pixels of a window on a 150% DPI secondary monitor left of primary', () => {
  // Premiere window at DIP (-1280, 100, 1200x800) on a 1.5x monitor -> physical
  const rect = dipToPhysical({ x: -1280, y: 100, width: 1200, height: 800 }, 1.5);
  assert.deepEqual(rect, { x: -1920, y: 150, width: 1800, height: 1200 });
  assert.deepEqual(normalizedToScreen(0, 0, rect), { x: -1920, y: 150 });
  assert.deepEqual(normalizedToScreen(0.5, 0.5, rect), { x: -1020, y: 750 });
  // the far edge maps to the last pixel inside the rect, never one past it
  assert.deepEqual(normalizedToScreen(1, 1, rect), { x: -1920 + 1799, y: 150 + 1199 });
});

test('normalizedToScreen is independent of the streamed resolution (720p of a 4K display)', () => {
  const display = { x: 0, y: 0, width: 3840, height: 2160 };
  // phone tapped pixel (640, 360) of a 1280x720 stream
  assert.deepEqual(normalizedToScreen(640 / 1280, 360 / 720, display), { x: 1920, y: 1080 });
});

test('normalizedToScreen clamps out-of-range input and rejects garbage', () => {
  const rect = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(normalizedToScreen(-3, 7, rect), { x: 10, y: 69 });
  assert.throws(() => normalizedToScreen(NaN, 0, rect), RangeError);
  assert.throws(() => normalizedToScreen(0, 0, { x: 0, y: 0, width: 0, height: 0 }), RangeError);
});
