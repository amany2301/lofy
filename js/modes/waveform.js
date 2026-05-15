/* lofy — Waveform / Oscilloscope mode
   Renders the time-domain audio signal (getByteTimeDomainData) as a
   continuous palette-gradient line. Beat slams brighten + thicken the
   stroke briefly; subtle reflection underneath gives it depth. */

let smoothed = null;
let beatGlow = 0;
let phaseDrift = 0;
let beatColorIx = 0;

// Pull a smoothed copy of the byte-time-domain data so the line doesn't
// jitter frame-to-frame on high-zoom signals. EMA smoothing per-sample.
function smooth(samples){
  if (!smoothed || smoothed.length !== samples.length){
    smoothed = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) smoothed[i] = (samples[i] - 128) / 128;
    return smoothed;
  }
  const a = 0.42; // higher = more reactive
  for (let i = 0; i < samples.length; i++){
    const v = (samples[i] - 128) / 128;     // -1 .. 1
    smoothed[i] += (v - smoothed[i]) * a;
  }
  return smoothed;
}

// Called once per detected beat — lights up the line briefly and rotates
// the dominant accent color through the palette.
export function onBeatWaveform(palette){
  beatColorIx++;
  beatGlow = 1;
}

export function drawWaveform(ctx, W, H, palette, opts){
  // Motion blur trail — gives the wave a phosphor / scope feel
  ctx.fillStyle = 'rgba(10,10,13,0.32)';
  ctx.fillRect(0, 0, W, H);

  const timeData = opts.timeData;
  if (!timeData || timeData.length < 2) return;

  const samples = smooth(timeData);
  const intensityScale = opts.intensityScale || 1;
  const total = Math.max(0, Math.min(1, opts.totalEnergy || 0));

  // Vertical amplitude — base + a touch of energy boost
  const amp = (H * 0.32) * (0.72 + total * 0.5);
  const midY = H * 0.5;

  // Per-frame palette gradient across the width of the canvas
  const grad = ctx.createLinearGradient(0, 0, W, 0);
  const stops = Math.max(2, Math.min(palette.length, 6));
  for (let i = 0; i < stops; i++){
    grad.addColorStop(i / (stops - 1), palette[i % palette.length] || '#f4f0e6');
  }

  // Subtle horizontal phase drift so the wave never feels static
  phaseDrift = (phaseDrift + 0.6) % (samples.length);

  // Main waveform stroke
  const baseLineW = 2.4 + beatGlow * 4.5 * intensityScale;
  ctx.lineWidth = baseLineW;
  ctx.strokeStyle = grad;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Beat-driven outer glow
  if (beatGlow > 0.05){
    ctx.shadowBlur = 18 * beatGlow * intensityScale;
    ctx.shadowColor = palette[beatColorIx % palette.length] || palette[0];
  } else {
    ctx.shadowBlur = 0;
  }

  ctx.beginPath();
  const step = Math.max(1, Math.floor(samples.length / W));
  for (let x = 0, i = 0; x <= W; x += 1, i += step){
    const sIx = (i + phaseDrift | 0) % samples.length;
    const v = samples[sIx];
    const y = midY + v * amp;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Mirrored reflection underneath, fainter — gives the canvas depth
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = baseLineW * 0.6;
  ctx.beginPath();
  for (let x = 0, i = 0; x <= W; x += 1, i += step){
    const sIx = (i + phaseDrift | 0) % samples.length;
    const v = samples[sIx];
    const y = midY - v * amp * 0.78 + H * 0.04;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Decay the beat glow
  beatGlow = Math.max(0, beatGlow - (opts.strobeGuard ? 0.04 : 0.055));
}

export function resetWaveform(){
  smoothed = null;
  beatGlow = 0;
  beatColorIx = 0;
  phaseDrift = 0;
}
