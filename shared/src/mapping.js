// Coordinate mapping. Two halves:
//  - viewToNormalized(): phone side — touch point in the video view -> normalized [0,1] frame coords,
//    accounting for letterboxing, pinch zoom and pan. The Kotlin client implements the same math
//    (CoordinateMapper.kt) and this file is the reference the tests pin down.
//  - normalizedToScreen(): host side — normalized frame coords -> physical Windows desktop pixels
//    of the captured rect (window or display). The companion process is per-monitor-DPI-aware,
//    so all rects here are PHYSICAL pixels; DPI scaling therefore needs no extra factor.

/** Letterboxed "fit" rectangle of a frame inside a view. */
export function fitRect(viewW, viewH, frameW, frameH) {
  if (!(viewW > 0 && viewH > 0 && frameW > 0 && frameH > 0)) return null;
  const s = Math.min(viewW / frameW, viewH / frameH);
  const w = frameW * s;
  const h = frameH * s;
  return { x: (viewW - w) / 2, y: (viewH - h) / 2, w, h };
}

/**
 * @param {number} px touch x in view coords
 * @param {number} py touch y in view coords
 * @param {{viewW:number, viewH:number, frameW:number, frameH:number, scale?:number, panX?:number, panY?:number}} v
 *   Display transform: screen = base * scale + pan (applied about the view origin).
 * @returns {{x:number,y:number}|null} null when the point lands in the letterbox / outside the frame.
 */
export function viewToNormalized(px, py, v) {
  const base = fitRect(v.viewW, v.viewH, v.frameW, v.frameH);
  if (!base) return null;
  const scale = v.scale ?? 1;
  const qx = (px - (v.panX ?? 0)) / scale;
  const qy = (py - (v.panY ?? 0)) / scale;
  const nx = (qx - base.x) / base.w;
  const ny = (qy - base.y) / base.h;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  return { x: nx, y: ny };
}

/** Clamp pan so the zoomed content never leaves a gap larger than the letterbox. */
export function clampPan(v) {
  const base = fitRect(v.viewW, v.viewH, v.frameW, v.frameH);
  const scale = Math.max(1, Math.min(v.scale ?? 1, 8));
  if (!base) return { scale, panX: 0, panY: 0 };
  const clampAxis = (pan, viewLen, start, len) => {
    const contentStart = start * scale;
    const contentLen = len * scale;
    if (contentLen <= viewLen) return (viewLen - contentLen) / 2 - contentStart; // keep centred
    const min = viewLen - (contentStart + contentLen);
    const max = -contentStart;
    return Math.min(max, Math.max(min, pan));
  };
  return {
    scale,
    // "+ 0" normalises -0 so callers can compare with ===
    panX: clampAxis(v.panX ?? 0, v.viewW, base.x, base.w) + 0,
    panY: clampAxis(v.panY ?? 0, v.viewH, base.y, base.h) + 0,
  };
}

/**
 * @param {number} nx normalized x in [0,1]
 * @param {number} ny normalized y in [0,1]
 * @param {{x:number,y:number,width:number,height:number}} rect captured rect, physical px, virtual-desktop coords (may be negative)
 * @returns {{x:number,y:number}} integer physical pixel inside rect
 */
export function normalizedToScreen(nx, ny, rect) {
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new RangeError('non-finite coordinate');
  if (!(rect && rect.width > 0 && rect.height > 0)) throw new RangeError('invalid capture rect');
  const cx = Math.min(1, Math.max(0, nx));
  const cy = Math.min(1, Math.max(0, ny));
  const x = rect.x + Math.min(rect.width - 1, Math.floor(cx * rect.width));
  const y = rect.y + Math.min(rect.height - 1, Math.floor(cy * rect.height));
  return { x, y };
}

/** Convert a DIP rect (Electron screen API) to physical pixels for a given scale factor. */
export function dipToPhysical(rect, scaleFactor) {
  return {
    x: Math.round(rect.x * scaleFactor),
    y: Math.round(rect.y * scaleFactor),
    width: Math.round(rect.width * scaleFactor),
    height: Math.round(rect.height * scaleFactor),
  };
}
