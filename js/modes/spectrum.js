/* lofy — Spectrum Bars mode
   Logarithmic frequency distribution across the audible musical range
   (~30 Hz – 14 kHz) so all bars actually carry signal — bass spreads
   into a few bars, mids and highs each get their share. */

const BARS = 64;
const MIN_FREQ = 30;
const MAX_FREQ = 14000;

const smoothed = new Float32Array(BARS);
const peaks = new Float32Array(BARS);

export function drawSpectrum(ctx, W, H, freqData, palette, opts){
  // motion-blur trail
  ctx.fillStyle = 'rgba(10,10,13,0.22)';
  ctx.fillRect(0, 0, W, H);

  if (!freqData) return;
  const sr = opts.sampleRate || 44100;
  const fft = opts.fftSize || 2048;
  const binHz = sr / fft;
  const len = freqData.length;
  const maxBin = Math.min(len - 1, Math.ceil(MAX_FREQ / binHz));

  const logRatio = Math.log(MAX_FREQ / MIN_FREQ);
  const bw = W / BARS;

  for (let i = 0; i < BARS; i++){
    const t1 = i / BARS;
    const t2 = (i + 1) / BARS;
    // exponential interpolation between MIN_FREQ and MAX_FREQ → log-spaced bins
    const f1 = MIN_FREQ * Math.exp(t1 * logRatio);
    const f2 = MIN_FREQ * Math.exp(t2 * logRatio);
    let startBin = Math.max(1, Math.floor(f1 / binHz));
    let endBin = Math.min(maxBin, Math.max(startBin + 1, Math.ceil(f2 / binHz)));

    // Use peak within the bar's bins — keeps narrow transient spikes visible
    let mag = 0;
    for (let b = startBin; b <= endBin; b++){
      if (freqData[b] > mag) mag = freqData[b];
    }

    // Lift the curve — high frequencies are naturally quieter, give them a boost
    const tCenter = (i + 0.5) / BARS;
    const hfBoost = 1 + tCenter * 0.6;       // 1.0 → 1.6 across the range
    const v = Math.min(1, (mag / 255) * hfBoost * (opts.gain || 1));

    smoothed[i] += (v - smoothed[i]) * (v > smoothed[i] ? 0.55 : 0.22);
    if (smoothed[i] > peaks[i]) peaks[i] = smoothed[i];
    peaks[i] = Math.max(0, peaks[i] - 0.014);

    const h = smoothed[i] * H * 0.92;
    const x = i * bw;

    // Use the full palette length when it has more than 4 stops (party
    // palettes can have 12+). Falls back to a 4-stop split for small palettes.
    let col;
    if (palette.length > 4){
      const t = i / (BARS - 1);
      col = palette[Math.floor(t * palette.length) % palette.length] || palette[0];
    } else {
      const t = i / (BARS - 1);
      if (t < 0.33)      col = palette[0] || '#ff2d87';
      else if (t < 0.66) col = palette[1] || '#7a3cff';
      else if (t < 0.85) col = palette[2] || '#00f0ff';
      else               col = palette[3] || palette[2] || '#d8ff3a';
    }

    ctx.fillStyle = col;
    ctx.shadowBlur = 16; ctx.shadowColor = col;
    ctx.fillRect(x + 1, H - h, bw - 2, h);
    ctx.shadowBlur = 0;

    // Peak dot
    const py = H - peaks[i] * H * 0.92 - 4;
    ctx.fillStyle = '#f4f0e6';
    ctx.fillRect(x + 1, py, bw - 2, 2);
  }
}

export function resetSpectrum(){
  smoothed.fill(0);
  peaks.fill(0);
}
