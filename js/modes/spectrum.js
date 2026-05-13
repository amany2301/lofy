/* lofy — Spectrum Bars mode */

const BARS = 64;
const smoothed = new Float32Array(BARS);
const peaks = new Float32Array(BARS);

export function drawSpectrum(ctx, W, H, freqData, palette, opts){
  // motion blur trail
  ctx.fillStyle = 'rgba(10,10,13,0.22)';
  ctx.fillRect(0, 0, W, H);

  if (!freqData) return;
  const len = freqData.length;
  // Map FFT bins (which span 0..nyquist) to bars on a log-ish scale —
  // gives a more musical distribution than linear.
  const bw = W / BARS;
  for (let i = 0; i < BARS; i++){
    const t = i / BARS;
    // log-ish bin distribution: low end gets more bars
    const startBin = Math.floor(Math.pow(t, 1.7) * len);
    const endBin = Math.max(startBin + 1, Math.floor(Math.pow((i+1)/BARS, 1.7) * len));
    let mag = 0;
    for (let b = startBin; b < endBin; b++) mag = Math.max(mag, freqData[b]);
    const v = (mag / 255) * (opts.gain || 1);
    smoothed[i] = smoothed[i] + (v - smoothed[i]) * 0.35;
    if (smoothed[i] > peaks[i]) peaks[i] = smoothed[i];
    peaks[i] = Math.max(0, peaks[i] - 0.006);

    const h = smoothed[i] * H * 0.92;
    const x = i * bw;
    const col = palette[ t < 0.33 ? 0 : t < 0.66 ? 1 : 2 ] || palette[0];

    ctx.fillStyle = col;
    ctx.shadowBlur = 16; ctx.shadowColor = col;
    ctx.fillRect(x + 1, H - h, bw - 2, h);
    ctx.shadowBlur = 0;

    // peak dot
    const py = H - peaks[i] * H * 0.92 - 4;
    ctx.fillStyle = '#f4f0e6';
    ctx.fillRect(x + 1, py, bw - 2, 2);
  }
}

export function resetSpectrum(){
  smoothed.fill(0);
  peaks.fill(0);
}
