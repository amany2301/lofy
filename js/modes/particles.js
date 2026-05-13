/* lofy — Particle Storm mode (v2)
   Continuous emission tied to instantaneous band energies + big bursts on
   detected beats. Canvas is always alive while audio is playing. */

let particles = [];
let maxParticles = 500;

// per-band onset trackers — small bursts on transients
const BANDS = [
  { lo:20,   hi:200,  buf:new Float32Array(10), ix:0, last:0 },
  { lo:200,  hi:2000, buf:new Float32Array(10), ix:0, last:0 },
  { lo:2000, hi:8000, buf:new Float32Array(10), ix:0, last:0 },
];

// drift particles continuously seeded from total energy
let driftAccumulator = 0;

export function setMaxParticles(n){ maxParticles = n; }

function emit(cx, cy, W, H, count, color, speedBase, sizeBase){
  for (let i = 0; i < count; i++){
    const ang = Math.random() * Math.PI * 2;
    const sp = speedBase * (0.5 + Math.random() * 0.9);
    particles.push({
      x: cx + (Math.random() - .5) * 14,
      y: cy + (Math.random() - .5) * 14,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: 1,
      decay: 0.005 + Math.random() * 0.013,
      size: sizeBase * (0.6 + Math.random() * 0.9),
      color,
    });
  }
  if (particles.length > maxParticles) particles.splice(0, particles.length - maxParticles);
}

// Big burst on the main detected beat
export function onBeatParticles(W, H, palette, energy){
  const cx = W / 2, cy = H / 2;
  const count = 30 + Math.floor(40 * energy);
  const speedBase = 2.2 + 5.5 * energy;
  const color = palette[Math.floor(Math.random() * palette.length)] || palette[0];
  emit(cx, cy, W, H, count, color, speedBase, 3 + 5 * energy);
}

// Per-band onset detection — fires colored bursts on each musical event
function bandOnset(band, freq, binHz, reactivity, nowMs){
  const a = Math.max(1, Math.floor(band.lo / binHz));
  const b = Math.min(freq.length - 1, Math.ceil(band.hi / binHz));
  let sum = 0, peak = 0;
  for (let i = a; i <= b; i++){
    sum += freq[i];
    if (freq[i] > peak) peak = freq[i];
  }
  const energy = (sum / Math.max(1, b - a + 1) * 0.5 + peak * 0.5) / 255;
  let avg = 0;
  for (let i = 0; i < band.buf.length; i++) avg += band.buf[i];
  avg /= band.buf.length;
  band.buf[band.ix] = energy;
  band.ix = (band.ix + 1) % band.buf.length;

  const threshold = 1.5 - (reactivity - 1) / 9 * 0.45;
  const floor = 0.06 - (reactivity - 1) / 9 * 0.05;
  const cooldown = 90;
  if (energy > floor && energy > avg * threshold && (nowMs - band.last) > cooldown){
    band.last = nowMs;
    return energy;
  }
  return 0;
}

// Called every frame — continuous reactive emission
export function tickParticles(W, H, palette, opts){
  const freq = opts.freqData;
  if (!freq) return;
  const sr = opts.sampleRate || 44100;
  const fft = opts.fftSize || 2048;
  const binHz = sr / fft;
  const reactivity = opts.reactivity || 7;
  const total = Math.max(0, Math.min(1, opts.totalEnergy || 0));
  const cx = W / 2, cy = H / 2;
  const now = performance.now();

  // ---- continuous drift emission proportional to total energy ----
  // reactivity 1..10 -> drift multiplier 0.6..3.0
  const driftMul = 0.6 + (reactivity / 10) * 2.4;
  driftAccumulator += total * driftMul * 1.8;
  while (driftAccumulator >= 1 && particles.length < maxParticles - 30){
    driftAccumulator -= 1;
    const ang = Math.random() * Math.PI * 2;
    const sp = 1.0 + Math.random() * 2.5;
    const c = palette[Math.floor(Math.random() * palette.length)] || palette[0];
    particles.push({
      x: cx + (Math.random() - .5) * 18,
      y: cy + (Math.random() - .5) * 18,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: 1,
      decay: 0.010 + Math.random() * 0.012,
      size: 2 + Math.random() * 4,
      color: c,
    });
  }

  // ---- per-band onset bursts ----
  BANDS.forEach((band, i) => {
    const e = bandOnset(band, freq, binHz, reactivity, now);
    if (e > 0){
      const color = palette[i % palette.length] || palette[0];
      const speed = 2 + e * 5;
      const count = 14 + Math.floor(e * 30);
      emit(cx, cy, W, H, count, color, speed, 2.5 + e * 4);
    }
  });
}

export function drawParticles(ctx, W, H){
  // Clean clear — clear particle look (no long trail per spec)
  ctx.fillStyle = 'rgba(10,10,13,0.34)';
  ctx.fillRect(0, 0, W, H);

  for (let i = particles.length - 1; i >= 0; i--){
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.986; p.vy *= 0.986;
    p.life -= p.decay;
    if (p.life <= 0){ particles.splice(i, 1); continue; }
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowBlur = 14; ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

export function resetParticles(){
  particles = [];
  driftAccumulator = 0;
  for (const b of BANDS){ b.buf.fill(0); b.ix = 0; b.last = 0; }
}
