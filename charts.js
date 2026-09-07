// Minimal canvas charts (no libraries). All functions take a <canvas> and draw at device pixel ratio.
(function (global) {
  // Every chart is drawn at devicePixelRatio (so it is crisp on HiDPI / zoomed displays) and is
  // re-drawn automatically whenever its canvas changes size (window resize, view becoming visible).
  const draws = new WeakMap();
  const sizes = new WeakMap();
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver((entries) => {
    entries.forEach((en) => {
      const c = en.target; const fn = draws.get(c); if (!fn) return;
      const s = sizes.get(c) || {}; const r = c.getBoundingClientRect();
      if (Math.round(r.width) !== s.w || Math.round(r.height) !== s.h) fn();
    });
  }) : null;
  function register(canvas, fn) {
    draws.set(canvas, fn);
    if (ro) ro.observe(canvas);
    fn();
  }

  function setup(canvas) {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(60, Math.round(rect.width || (canvas.parentElement && canvas.parentElement.clientWidth) || 300));
    const h = Math.max(60, Math.round(rect.height || 200));
    sizes.set(canvas, { w, h });
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.lineJoin = 'round';
    return { ctx, w, h };
  }
  const crisp = (v) => Math.round(v) + 0.5; // align 1px lines to the pixel grid

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  const palette = () => ({
    text: cssVar('--muted', '#94a3b8'),
    grid: cssVar('--border', '#2a2f3a'),
    accent: cssVar('--accent', '#7c5cff'),
    green: cssVar('--green', '#22c55e'),
    amber: cssVar('--amber', '#f59e0b'),
    red: cssVar('--red', '#ef4444'),
    blue: cssVar('--blue', '#38bdf8'),
    track: cssVar('--track', '#1f2430'),
  });

  // Donut: segments = [{value, color, label}], center text
  function donut(canvas, segments, centerText, subText) { register(canvas, () => drawDonut(canvas, segments, centerText, subText)); }
  function drawDonut(canvas, segments, centerText, subText) {
    const { ctx, w, h } = setup(canvas);
    const p = palette();
    const cx = w / 2, cy = h / 2;
    const r = Math.min(w, h) / 2 - 8;
    const thick = Math.max(10, r * 0.28);
    const total = segments.reduce((s, x) => s + x.value, 0);
    let a = -Math.PI / 2;
    ctx.lineWidth = thick;
    ctx.lineCap = 'butt';
    // track
    ctx.beginPath();
    ctx.strokeStyle = p.track;
    ctx.arc(cx, cy, r - thick / 2, 0, Math.PI * 2);
    ctx.stroke();
    if (total > 0) {
      segments.forEach((s) => {
        if (s.value <= 0) return;
        const ang = (s.value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.strokeStyle = s.color;
        ctx.arc(cx, cy, r - thick / 2, a, a + ang);
        ctx.stroke();
        a += ang;
      });
    }
    ctx.fillStyle = cssVar('--text', '#e5e7eb');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.max(16, r * 0.42)}px system-ui, sans-serif`;
    ctx.fillText(centerText, cx, cy - (subText ? 6 : 0));
    if (subText) {
      ctx.fillStyle = p.text;
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(subText, cx, cy + Math.max(12, r * 0.22));
    }
  }

  // Bars: data = [{label, value, max?, color?, highlight?}], yMax
  function bars(canvas, data, opts = {}) { register(canvas, () => drawBars(canvas, data, opts)); }
  function drawBars(canvas, data, opts) {
    const { ctx, w, h } = setup(canvas);
    const p = palette();
    const padL = 38, padR = 8, padT = 10, padB = 24;
    const cw = w - padL - padR, ch = h - padT - padB;
    const yMax = opts.yMax || Math.max(1, ...data.map((d) => d.value));
    // grid
    ctx.strokeStyle = p.grid;
    ctx.fillStyle = p.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const ticks = opts.ticks || 4;
    for (let i = 0; i <= ticks; i++) {
      const y = crisp(padT + ch - (ch * i) / ticks);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      const val = (yMax * i) / ticks;
      ctx.fillText(opts.yFormat ? opts.yFormat(val) : Math.round(val), padL - 6, y);
    }
    const n = data.length;
    const gap = Math.min(10, cw / n * 0.3);
    const bw = (cw - gap * (n - 1)) / n;
    data.forEach((d, i) => {
      const x = padL + i * (bw + gap);
      const bh = (Math.min(d.value, yMax) / yMax) * ch;
      const y = padT + ch - bh;
      ctx.fillStyle = p.track;
      roundRect(ctx, x, padT, bw, ch, 4);
      ctx.fill();
      ctx.fillStyle = d.color || p.accent;
      if (bh > 0) {
        roundRect(ctx, x, y, bw, bh, 4);
        ctx.fill();
      }
      if (d.highlight) {
        ctx.strokeStyle = d.highlight;
        ctx.lineWidth = 2;
        roundRect(ctx, x + 1, padT + 1, bw - 2, ch - 2, 4);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      ctx.fillStyle = p.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      if (n <= 20 || i % 2 === 0) ctx.fillText(d.label, x + bw / 2, padT + ch + 6);
    });
  }

  // Line/area: series = [{name, color, values:number[]}], labels: string[]
  function lines(canvas, labels, series, opts = {}) { register(canvas, () => drawLines(canvas, labels, series, opts)); }
  function drawLines(canvas, labels, series, opts) {
    const { ctx, w, h } = setup(canvas);
    const p = palette();
    const padL = 30, padR = 10, padT = 10, padB = 24;
    const cw = w - padL - padR, ch = h - padT - padB;
    const yMax = Math.max(opts.minMax || 1, ...series.flatMap((s) => s.values));
    const ticks = yMax <= 4 ? yMax : 4;
    ctx.strokeStyle = p.grid;
    ctx.fillStyle = p.text;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= ticks; i++) {
      const y = crisp(padT + ch - (ch * i) / ticks);
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(Math.round((yMax * i) / ticks), padL - 6, y);
    }
    const n = labels.length;
    const xAt = (i) => padL + (n <= 1 ? cw / 2 : (cw * i) / (n - 1));
    const yAt = (v) => padT + ch - (v / yMax) * ch;
    series.forEach((s) => {
      // area
      ctx.beginPath();
      s.values.forEach((v, i) => (i === 0 ? ctx.moveTo(xAt(i), yAt(v)) : ctx.lineTo(xAt(i), yAt(v))));
      ctx.lineTo(xAt(n - 1), padT + ch);
      ctx.lineTo(xAt(0), padT + ch);
      ctx.closePath();
      ctx.fillStyle = hexA(s.color, 0.15);
      ctx.fill();
      // line
      ctx.beginPath();
      s.values.forEach((v, i) => (i === 0 ? ctx.moveTo(xAt(i), yAt(v)) : ctx.lineTo(xAt(i), yAt(v))));
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
      // points
      s.values.forEach((v, i) => {
        if (v <= 0) return;
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(v), 3, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
      });
    });
    ctx.fillStyle = p.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const step = Math.ceil(n / Math.max(1, Math.floor(cw / 48)));
    labels.forEach((l, i) => {
      if (i % step === 0 || i === n - 1) ctx.fillText(l, xAt(i), padT + ch + 6);
    });
  }

  // Heat strip: 7 columns × N rows (weeks), value 0..max
  function heatmap(canvas, cells, opts = {}) { register(canvas, () => drawHeatmap(canvas, cells, opts)); }
  function drawHeatmap(canvas, cells, opts) {
    // cells: array of {value, label}, laid out in rows of 7 (Mon..Sun)
    const { ctx, w, h } = setup(canvas);
    const p = palette();
    const cols = 7;
    const rows = Math.ceil(cells.length / cols);
    const padL = 30, padT = 18;
    const gap = 4;
    const size = Math.min((w - padL) / cols - gap, (h - padT) / rows - gap);
    const max = Math.max(1, ...cells.map((c) => c.value));
    const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    ctx.fillStyle = p.text;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let c = 0; c < cols; c++) ctx.fillText(days[c], padL + c * (size + gap) + size / 2, 8);
    cells.forEach((cell, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const x = padL + c * (size + gap), y = padT + r * (size + gap);
      if (c === 0) {
        ctx.fillStyle = p.text;
        ctx.textAlign = 'right';
        ctx.fillText(cell.rowLabel || '', padL - 6, y + size / 2);
      }
      const t = cell.value / max;
      ctx.fillStyle = cell.future ? 'transparent' : t === 0 ? p.track : hexA(p.green, 0.25 + 0.75 * t);
      roundRect(ctx, x, y, size, size, 3);
      ctx.fill();
      if (cell.today) {
        ctx.strokeStyle = p.accent;
        ctx.lineWidth = 2;
        roundRect(ctx, x + 1, y + 1, size - 2, size - 2, 3);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    });
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function hexA(hex, a) {
    hex = hex.trim();
    if (hex.startsWith('rgb')) return hex.replace(/rgba?\(([^)]+)\)/, (m, inner) => `rgba(${inner.split(',').slice(0, 3).join(',')},${a})`);
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  global.Charts = { donut, bars, lines, heatmap };
})(window);
