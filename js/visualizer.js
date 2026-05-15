/* lofy — Render loop + mode dispatcher (v1.2 — A-weighted, dual-analyser)

   Changes vs v1.1:
   • The BeatDetector now reads from a SEPARATE AnalyserNode (1024 / 0.4
     smoothing) tuned for transient detection. Mode renderers continue to
     read from the spectrum analyser (2048 / 0.85 smoothing).
   • Total energy uses A-weighted RMS instead of the old magic 2.4×
     average — sub-bass no longer drowns out everything else.
   • Hue rotation phase advances proportional to energy, not wall-clock,
     so quiet sections drift slowly and drops accelerate.
   • New `bumpFeedback()` lets the controls flash a tint when a slider
     changes (makes the controls feel responsive even between beats).
   • Exposed `totalEnergyEma` so the UI can paint a live mic level meter.
*/

import { drawSpectrum, resetSpectrum } from './modes/spectrum.js';
import { drawFlash, onBeatFlash, resetFlash } from './modes/flash.js';
import { drawParticles, onBeatParticles, resetParticles, setMaxParticles, getMaxParticles, tickParticles } from './modes/particles.js';
import { BeatDetector } from './bpm.js';

export class Visualizer {
  constructor(canvas, audio){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha:false });
    this.audio = audio;
    this.W = 0; this.H = 0; this.DPR = 1;
    this.mode = 'spectrum';
    this.palette = ['#ff2d87','#7a3cff','#00f0ff','#d8ff3a'];
    this.intensity = 'med';
    this.reactivity = 7;
    this.strobeGuard = false;
    this.hueRotate = false;
    this.hueCycleSec = 45;
    this._basePalette = null;
    this._hueRotatePhase = 0;          // accumulated phase (energy-driven)
    this._lastHueT = 0;
    this.fps = 60;
    this._fpsEma = 60;
    this.onFps = null;
    this.detector = new BeatDetector();
    this.onBeat = null;
    this._lastBeatEnergy = 0;
    this._raf = 0;
    this._fpsLow = 0;
    this._lastFrameT = 0;
    this.totalEnergyEma = 0;           // smoothed loudness — for UI meter

    // Slider feedback bump
    this._bumpAlpha = 0;
    this._bumpColor = '#ffffff';

    // A-weighting lookup, lazily built once we know binHz from the analyser
    this._aWeights = null;
    this._aWeightsBinHz = 0;
    this._aWeightsSum = 0;

    if (window.innerWidth < 768 || ('ontouchstart' in window)){
      setMaxParticles(200);
    }

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  resize(){
    this.DPR = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.W = r.width; this.H = r.height;
    this.canvas.width = this.W * this.DPR;
    this.canvas.height = this.H * this.DPR;
    this.ctx.setTransform(this.DPR, 0, 0, this.DPR, 0, 0);
  }

  setMode(m){
    this.mode = m;
    resetSpectrum(); resetFlash(); resetParticles();
    this.ctx.fillStyle = '#0a0a0d';
    this.ctx.fillRect(0, 0, this.W, this.H);
  }
  setPalette(input){
    let colors, party = false, partyStrobeMs = 120;
    if (Array.isArray(input)){
      colors = input;
    } else if (input && typeof input === 'object'){
      colors = (input.colors || input.palette || []).slice();
      party = !!input.party;
      partyStrobeMs = +input.partyStrobeMs || 120;
    } else {
      return;
    }
    this.palette = colors.slice();
    this.party = party;
    this.partyStrobeMs = partyStrobeMs;
    this._partyStart = performance.now();

    if (this.hueRotate){
      this._basePalette = colors.slice();
    } else {
      this._basePalette = null;
    }
    resetFlash();
  }
  setIntensity(level){ this.intensity = level; }
  setManualBpm(n){ this.detector.setManualBpm(n); }
  setHueRotate(on, cycleSec){
    this.hueRotate = !!on;
    if (cycleSec) this.hueCycleSec = Math.max(5, +cycleSec);
    if (on){
      this._basePalette = (this._basePalette || this.palette).slice();
      this._hueRotatePhase = 0;
      this._lastHueT = 0;
    } else {
      if (this._basePalette){
        this.palette = this._basePalette.slice();
        this._basePalette = null;
      }
    }
  }
  setHueCycleSec(sec){ this.hueCycleSec = Math.max(5, +sec || 45); }
  setReactivity(v){
    this.reactivity = Math.max(1, Math.min(10, +v || 7));
    this.detector.threshold     = 1.45 - (this.reactivity - 1) / 9 * 0.35;
    this.detector.energyFloor   = 0.05 - (this.reactivity - 1) / 9 * 0.04;
    this.detector.fluxThreshold = 1.80 - (this.reactivity - 1) / 9 * 0.50;
    this.detector.fluxFloor     = 0.025 - (this.reactivity - 1) / 9 * 0.020;
  }
  setStrobeGuard(on){
    this.strobeGuard = !!on;
    this.detector.setStrobeGuard(on);
  }

  // Brief tint of the canvas — fires when a control changes so the user
  // gets instant feedback without waiting for the next beat.
  bumpFeedback(color, strength = 0.18){
    this._bumpColor = color || '#ffffff';
    this._bumpAlpha = Math.max(this._bumpAlpha, strength);
  }

  _intensityScale(){
    return this.intensity === 'low' ? 0.55 : this.intensity === 'high' ? 1.0 : 0.8;
  }

  // Build (and cache) the A-weighting coefficient table for the current
  // spectrum analyser's bin spacing. A-weighting approximates human
  // hearing — quiet rumble doesn't pretend to be loud, bright mids count.
  _ensureAWeights(binHz, len){
    if (this._aWeights && this._aWeightsBinHz === binHz && this._aWeights.length === len) return;
    const w = new Float32Array(len);
    let sum = 0;
    for (let i = 0; i < len; i++){
      const f = i * binHz;
      if (f < 20) { w[i] = 0; continue; }
      const f2 = f * f, f4 = f2 * f2;
      const num = 12194 * 12194 * f4;
      const den = (f2 + 20.6 * 20.6)
                * Math.sqrt((f2 + 107.7 * 107.7) * (f2 + 737.9 * 737.9))
                * (f2 + 12194 * 12194);
      const ra = num / den;
      // +2 dB normalisation so 1 kHz lands close to 1.0
      w[i] = ra * 1.2589;
      sum += w[i];
    }
    this._aWeights = w;
    this._aWeightsBinHz = binHz;
    this._aWeightsSum = sum;
  }

  start(){
    if (this._raf) return;
    const tick = (t) => {
      this._raf = requestAnimationFrame(tick);
      this.render(t);
    };
    this._raf = requestAnimationFrame(tick);
  }

  stop(){
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  render(t){
    if (!this.audio.analyser){
      this.ctx.fillStyle = '#0a0a0d';
      this.ctx.fillRect(0, 0, this.W, this.H);
      return;
    }
    const freq = this.audio.getFrequencyData();
    const freqBeat = this.audio.getBeatFrequencyData
      ? this.audio.getBeatFrequencyData()
      : freq;
    if (!freq || !this.audio.ctx?.sampleRate || !this.audio.analyser?.fftSize){
      this.ctx.fillStyle = '#0a0a0d';
      this.ctx.fillRect(0, 0, this.W, this.H);
      return;
    }
    const now = performance.now();
    const sr = this.audio.ctx.sampleRate;
    const fftSize = this.audio.analyser.fftSize;
    const binHz = sr / fftSize;

    this._ensureAWeights(binHz, freq.length);
    const aw = this._aWeights;

    // ---- Low-band energy (bass / kick region) — used for kick scaling ----
    const a0 = Math.max(1, Math.floor(20  / binHz));
    const a1 = Math.min(freq.length - 1, Math.ceil(200 / binHz));
    let sLow = 0, nLow = 0;
    for (let i = a0; i <= a1; i++){ sLow += freq[i] * aw[i]; nLow += aw[i]; }
    const lowEnergy = Math.min(1, nLow > 0 ? (sLow / nLow) / 255 * 1.6 : 0);

    // ---- Total energy: A-weighted RMS across audible spectrum ----
    let acc = 0, weightSum = 0;
    const half = Math.floor(freq.length * 0.85);
    for (let i = 1; i < half; i++){
      const v = freq[i] / 255;
      acc       += v * v * aw[i];
      weightSum += aw[i];
    }
    const rms = weightSum > 0 ? Math.sqrt(acc / weightSum) : 0;
    const totalEnergy = Math.min(1, rms * 1.6);
    // Exponential smoothing for the UI level meter — slow-decay, fast-attack
    this.totalEnergyEma += (totalEnergy - this.totalEnergyEma)
      * (totalEnergy > this.totalEnergyEma ? 0.35 : 0.08);
    this.lastTotalEnergy = totalEnergy;

    // ---- Energy-coupled hue rotation ----
    if (this.hueRotate && this._basePalette){
      const lastT = this._lastHueT || now;
      const dt = now - lastT;
      this._lastHueT = now;
      // Phase advances 360° per hueCycleSec on average; scaled by 0.4..1.6
      // by current energy so quiet sections crawl, busy sections sprint.
      const speed = 0.4 + Math.min(1.2, totalEnergy * 2.0);
      this._hueRotatePhase += dt / (this.hueCycleSec * 1000) * 360 * speed;
      this._hueRotatePhase %= 360;
      this.palette = this._basePalette.map(hex => hueShift(hex, this._hueRotatePhase));
    }

    // ---- Beat detection (uses snappy beat analyser) ----
    const beatFftSize = this.audio.analyserBeat?.fftSize || fftSize;
    const beat = this.detector.update(freqBeat, sr, beatFftSize, now);
    if (beat){
      this._lastBeatEnergy = lowEnergy;
      onBeatFlash(this.palette);
      onBeatParticles(this.W, this.H, this.palette, lowEnergy);
      if (this.onBeat) this.onBeat(this.detector.bpm);
    }

    const opts = {
      gain: 1,
      strobeGuard: this.strobeGuard,
      intensityScale: this._intensityScale(),
      reactivity: this.reactivity,
      lowEnergy,
      totalEnergy,
      freqData: freq,
      sampleRate: sr,
      fftSize: fftSize,
      party: this.party,
      partyStrobeMs: this.partyStrobeMs,
      partyStart: this._partyStart,
      now,
    };

    if (this.mode === 'spectrum') drawSpectrum(this.ctx, this.W, this.H, freq, this.palette, opts);
    else if (this.mode === 'flash') drawFlash(this.ctx, this.W, this.H, this.palette, opts);
    else {
      tickParticles(this.W, this.H, this.palette, opts);
      drawParticles(this.ctx, this.W, this.H);
    }

    // Slider feedback bump — painted on top, decays fast
    if (this._bumpAlpha > 0.005){
      this.ctx.fillStyle = this._bumpColor;
      this.ctx.globalAlpha = this._bumpAlpha;
      this.ctx.fillRect(0, 0, this.W, this.H);
      this.ctx.globalAlpha = 1;
      this._bumpAlpha *= 0.78;
    }

    // ---- FPS + dynamic particle ceiling ----
    if (this._lastFrameT){
      const dt = t - this._lastFrameT;
      if (dt > 0){
        const instant = 1000 / dt;
        this._fpsEma = this._fpsEma * 0.92 + instant * 0.08;
        this.fps = Math.round(this._fpsEma);
        if (this.onFps) this.onFps(this.fps);
      }
      if (dt > 34){
        this._fpsLow++;
        if (this._fpsLow > 60){
          setMaxParticles(150);
          this._fpsLow = 0;
        }
      } else if (this._fpsLow > 0){
        this._fpsLow--;
      }
      // Slow recovery: when FPS is healthy for a sustained period, bump
      // the particle ceiling back up by 25 each cycle until 500.
      if (dt < 17){
        this._fpsHigh = (this._fpsHigh || 0) + 1;
        if (this._fpsHigh > 90){
          const cur = getMaxParticles();
          const desktopCap = (window.innerWidth >= 768 && !('ontouchstart' in window)) ? 500 : 200;
          if (cur < desktopCap) setMaxParticles(Math.min(desktopCap, cur + 25));
          this._fpsHigh = 0;
        }
      } else {
        this._fpsHigh = 0;
      }
    }
    this._lastFrameT = t;
  }
}

/* ----- hue rotation helper (unchanged) ----- */
function hueShift(hex, deg){
  const m = String(hex).replace('#','').match(/[0-9a-f]{6}/i);
  if (!m) return hex;
  const v = parseInt(m[0], 16);
  let r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  const rn = r/255, gn = g/255, bn = b/255;
  const max = Math.max(rn,gn,bn), min = Math.min(rn,gn,bn);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min){
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max){
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      case bn: h = (rn - gn) / d + 4; break;
    }
    h *= 60;
  }
  h = (h + deg) % 360;
  if (h < 0) h += 360;
  const hue2rgb = (p,q,t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  let r2,g2,b2;
  if (s === 0){ r2 = g2 = b2 = l; }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hn = h / 360;
    r2 = hue2rgb(p, q, hn + 1/3);
    g2 = hue2rgb(p, q, hn);
    b2 = hue2rgb(p, q, hn - 1/3);
  }
  const to = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return '#' + to(r2) + to(g2) + to(b2);
}
