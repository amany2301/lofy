/* lofy — Beat Flash mode (v4)
   Reliable, always-alive DJ flash:
     • A base color tint is ALWAYS drawn. Its brightness tracks instantaneous
       audio energy in real time (no rolling-average lag).
     • The active color smoothly rotates to the next palette color on every
       detected beat — so the room visibly changes color with the music.
     • Each band (bass / mid / high) also fires a sharp colored slam when
       its energy spikes — adds punch on top of the base tint.
     • Main BPM-beat slams the canvas with the next palette color for one
       hard kick pulse, eased to black over ~300ms. */

let flashAlpha = 0;
let beatIx = 0;
let curIx = 0;          // current palette index (smoothly interpolated)

// per-band onset trackers (very short memory)
const BANDS = [
  { lo:20,   hi:200,  alpha:0, color:'#ff2d87', buf:new Float32Array(10), ix:0, last:0, decay:0.060 },
  { lo:200,  hi:2000, alpha:0, color:'#7a3cff', buf:new Float32Array(10), ix:0, last:0, decay:0.075 },
  { lo:2000, hi:8000, alpha:0, color:'#00f0ff', buf:new Float32Array(10), ix:0, last:0, decay:0.090 },
];

let totalEnv = 0;
let ambient = [];

function ensureAmbient(W, H, palette){
  if (ambient.length) return;
  for (let i = 0; i < 3; i++){
    ambient.push({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 240 + Math.random() * 220,
      vx: (Math.random() - .5) * 0.2,
      vy: (Math.random() - .5) * 0.2,
      c: palette[i % palette.length],
    });
  }
}

function mixHex(a, b, t){
  const pa = parseInt(a.replace('#',''), 16), pb = parseInt(b.replace('#',''), 16);
  const ra = (pa>>16)&255, ga = (pa>>8)&255, ba = pa&255;
  const rb = (pb>>16)&255, gb = (pb>>8)&255, bb = pb&255;
  const r = Math.round(ra + (rb-ra)*t);
  const g = Math.round(ga + (gb-ga)*t);
  const bl = Math.round(ba + (bb-ba)*t);
  return `rgb(${r},${g},${bl})`;
}

export function onBeatFlash(palette){
  beatIx++;
  flashAlpha = 1;
}

function detectBandOnset(band, freqData, binHz, reactivity, nowMs){
  const a = Math.max(1, Math.floor(band.lo / binHz));
  const b = Math.min(freqData.length - 1, Math.ceil(band.hi / binHz));
  let sum = 0, peak = 0;
  for (let i = a; i <= b; i++){
    sum += freqData[i];
    if (freqData[i] > peak) peak = freqData[i];
  }
  const energy = (sum / Math.max(1, b - a + 1) * 0.5 + peak * 0.5) / 255;
  let avg = 0;
  for (let i = 0; i < band.buf.length; i++) avg += band.buf[i];
  avg /= band.buf.length;
  band.buf[band.ix] = energy;
  band.ix = (band.ix + 1) % band.buf.length;

  // reactivity 1..10 → threshold 1.55 .. 1.05
  const threshold = 1.55 - (reactivity - 1) / 9 * 0.50;
  const floor = 0.06 - (reactivity - 1) / 9 * 0.05;   // 0.06 .. 0.01
  const cooldown = 80;
  if (energy > floor && energy > avg * threshold && (nowMs - band.last) > cooldown){
    band.last = nowMs;
    return Math.min(1, energy * 1.4);
  }
  return 0;
}

export function drawFlash(ctx, W, H, palette, opts){
  const freq = opts.freqData;
  const sr = opts.sampleRate || 44100;
  const fft = opts.fftSize || 2048;
  const reactivity = opts.reactivity || 7;
  const intensityScale = opts.intensityScale || 1;
  const total = Math.max(0, Math.min(1, opts.totalEnergy || 0));

  // fast-attack, slow-release envelope of overall energy
  totalEnv += (total - totalEnv) * (total > totalEnv ? 0.55 : 0.10);

  // Smoothly approach the latest beat index — gives a gentle color transition
  // instead of a snap. Higher reactivity = faster shifts.
  const lerp = 0.06 + (reactivity / 10) * 0.18;
  curIx += (beatIx - curIx) * lerp;

  // Current active color = interpolation between two adjacent palette stops
  const lo = Math.floor(curIx);
  const frac = curIx - lo;
  const cA = palette[((lo % palette.length) + palette.length) % palette.length] || '#ff2d87';
  const cB = palette[(((lo + 1) % palette.length) + palette.length) % palette.length] || cA;
  const activeColor = mixHex(cA, cB, frac);

  // Hard clear — no trail
  ctx.fillStyle = '#0a0a0d';
  ctx.fillRect(0, 0, W, H);

  // Subtle ambient drift (background hint only)
  ensureAmbient(W, H, palette);
  for (const a of ambient){
    a.x += a.vx; a.y += a.vy;
    if (a.x < -a.r) a.x = W + a.r; if (a.x > W + a.r) a.x = -a.r;
    if (a.y < -a.r) a.y = H + a.r; if (a.y > H + a.r) a.y = -a.r;
    const grd = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, a.r);
    grd.addColorStop(0, a.c + '14');
    grd.addColorStop(1, a.c + '00');
    ctx.fillStyle = grd;
    ctx.fillRect(a.x - a.r, a.y - a.r, a.r * 2, a.r * 2);
  }

  // === BASE: always-visible active color, brightness modulated by energy ===
  // baseline floor of 0.18 ensures the canvas is never fully black while audio source is on
  // reactivity scales how aggressively energy boosts brightness
  const reactGain = 0.6 + (reactivity / 10) * 1.8;       // 0.6 .. 2.4
  const energyBoost = Math.min(0.85, totalEnv * reactGain);
  const baseAlpha = Math.min(0.92, 0.18 + energyBoost) * intensityScale;
  ctx.fillStyle = activeColor;
  ctx.globalAlpha = baseAlpha;
  ctx.fillRect(0, 0, W, H);
  ctx.globalAlpha = 1;

  // === BAND ONSETS: rapid colored stabs on transients ===
  if (freq){
    const binHz = sr / fft;
    const now = performance.now();
    BANDS.forEach((band, i) => {
      const fired = detectBandOnset(band, freq, binHz, reactivity, now);
      if (fired > 0){
        band.alpha = fired;
        band.color = palette[(beatIx + i) % palette.length] || band.color;
      }
    });
  }
  for (const band of BANDS){
    if (band.alpha > 0){
      const eased = Math.pow(band.alpha, 0.5);
      ctx.fillStyle = band.color;
      ctx.globalAlpha = Math.min(0.9, eased * 0.6 * intensityScale);
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
      band.alpha = Math.max(0, band.alpha - band.decay);
    }
  }

  // === MAIN KICK SLAM ===
  if (flashAlpha > 0){
    const decay = opts.strobeGuard ? 0.05 : 0.058;
    const eased = Math.pow(flashAlpha, 0.55);
    ctx.fillStyle = palette[(beatIx + 1) % palette.length] || activeColor;
    ctx.globalAlpha = Math.min(1, eased * 0.92 * intensityScale);
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
    flashAlpha = Math.max(0, flashAlpha - decay);
  }
}

export function resetFlash(){
  flashAlpha = 0;
  beatIx = 0;
  curIx = 0;
  totalEnv = 0;
  ambient = [];
  for (const b of BANDS){
    b.alpha = 0; b.last = 0; b.buf.fill(0); b.ix = 0;
  }
}
