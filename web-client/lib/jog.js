// Jog wheel: clockwise = forward. Frames are accumulated and flushed every 80 ms as one stepFrames
// command, so a fast spin never floods the PC with stale per-frame events.

export function createJog(canvas, onFrames) {
  const ctx = canvas.getContext('2d');
  const st = { angle: 0, last: null, acc: 0, pending: 0, precision: false, enabled: false };

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    if (w < 24) return; // hidden screen: nothing to draw yet (ResizeObserver redraws when shown)
    canvas.width = w * dpr;
    canvas.height = w * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = w / 2;
    ctx.clearRect(0, 0, w, w);
    ctx.fillStyle = '#2a2a30';
    ctx.beginPath(); ctx.arc(r, r, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = st.precision ? '#ffb547' : '#8b80ff';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(r, r, r - 4, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#6b6b70';
    ctx.lineWidth = 2;
    for (let i = 0; i < 24; i++) {
      const t = ((st.angle + i * 15) * Math.PI) / 180;
      ctx.beginPath();
      ctx.moveTo(r + Math.cos(t) * (r - 22), r + Math.sin(t) * (r - 22));
      ctx.lineTo(r + Math.cos(t) * (r - 10), r + Math.sin(t) * (r - 10));
      ctx.stroke();
    }
    ctx.fillStyle = '#444450';
    ctx.beginPath(); ctx.arc(r, r, r * 0.28, 0, Math.PI * 2); ctx.fill();
  }

  const angleOf = (t) => {
    const b = canvas.getBoundingClientRect();
    return (Math.atan2(t.clientY - (b.top + b.height / 2), t.clientX - (b.left + b.width / 2)) * 180) / Math.PI;
  };
  const move = (t) => {
    if (!st.enabled) return;
    const a = angleOf(t);
    if (st.last !== null) {
      let d = a - st.last;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      st.angle += d;
      st.acc += d;
      const per = st.precision ? 30 : 8;
      const n = Math.trunc(st.acc / per);
      if (n) { st.pending += n; st.acc -= n * per; }
      draw();
    }
    st.last = a;
  };
  canvas.addEventListener('touchstart', (e) => { e.preventDefault(); st.last = null; move(e.touches[0]); }, { passive: false });
  canvas.addEventListener('touchmove', (e) => { e.preventDefault(); move(e.touches[0]); }, { passive: false });
  canvas.addEventListener('touchend', () => { st.last = null; });
  let mouse = false;
  canvas.addEventListener('mousedown', (e) => { mouse = true; st.last = null; move(e); });
  window.addEventListener('mousemove', (e) => { if (mouse) move(e); });
  window.addEventListener('mouseup', () => { mouse = false; st.last = null; });

  setInterval(() => {
    if (st.pending) {
      const n = Math.max(-600, Math.min(600, st.pending));
      st.pending = 0;
      onFrames(n);
    }
  }, 80);

  draw();
  new ResizeObserver(draw).observe(canvas);
  return {
    setPrecision(p) { st.precision = p; draw(); },
    setEnabled(e) { st.enabled = e; },
  };
}
