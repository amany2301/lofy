/* lofy — Render loop + mode dispatcher */
import { drawSpectrum, resetSpectrum } from './modes/spectrum.js';
import { drawFlash, onBeatFlash, resetFlash } from './modes/flash.js';
import { drawParticles, onBeatParticles, resetParticles, setMaxParticles, tickParticles } from './modes/particles.js';
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
    this.reactivity = 7;     // 1..10 — how easily band onsets fire
    this.strobeGuard = false;
    this.hueRotate = false;
    this.hueCycleSec = 45;
    this._basePalette = null;        // original colors before hue rotation
    this._hueRotateStart = 0;
    this.fps = 60;
    this._fpsEma = 60;
    this.onFps = null;
    this.detector = new BeatDetector();
    this.onBeat = null;     // (bpm) cb
    this._lastBeatEnergy = 0;
    this._raf = 0;
    this._fpsLow = 0;       // counter for low fps frames
    this._lastFrameT = 0;

    // mobile particle reduction
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
    // initial clear
    this.ctx.fillStyle = '#0a0a0d';
    this.ctx.fillRect(0, 0, this.W, this.H);
  }
  setPalette(colors){
    this.palette = colors.slice();
    // If hue rotation is on, keep the new colors as the base
    if (this.hueRotate){
      this._basePalette = colors.slice();
      this._hueRotateStart = performance.now();
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
      this._hueRotateStart = performance.now();
    } else {
      // restore original
      if (this._basePalette){
        this.palette = this._basePalette.slice();
        this._basePalette = null;
      }
    }
  }
  setHueCycleSec(sec){
    this.hueCycleSec = Math.max(5, +sec || 45);
  }
  setReactivity(v){
    this.reactivity = Math.max(1, Math.min(10, +v || 7));
    // higher reactivity also relaxes the main BPM detector
    this.detector.threshold = 1.45 - (this.reactivity - 1) / 9 * 0.35;
    this.detector.energyFloor = 0.05 - (this.reactivity - 1) / 9 * 0.04;
  }
  setStrobeGuard(on){
    this.strobeGuard = !!on;
    this.detector.setStrobeGuard(on);
  }

  _intensityScale(){
    return this.intensity === 'low' ? 0.55 : this.intensity === 'high' ? 1.0 : 0.8;
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
    // Idle screen if no audio context yet
    if (!this.audio.analyser){
      this.ctx.fillStyle = '#0a0a0d';
      this.ctx.fillRect(0, 0, this.W, this.H);
      return;
    }

    const freq = this.audio.getFrequencyData();
    if (!freq || !this.audio.ctx?.sampleRate || !this.audio.analyser?.fftSize){
      this.ctx.fillStyle = '#0a0a0d';
      this.ctx.fillRect(0, 0, this.W, this.H);
      return;
    }
    const now = performance.now();

    // Hue rotation — recompute palette from base
    if (this.hueRotate && this._basePalette){
      const phase = ((now - this._hueRotateStart) / (this.hueCycleSec * 1000)) * 360;
      this.palette = this._basePalette.map(hex => hueShift(hex, phase));
    }

    // Always compute multi-band energy — used by Flash for continuous reactivity
    // and by Particles for emission scaling on beat.
    const binHz = this.audio.ctx.sampleRate / this.audio.analyser.fftSize;
    const a = Math.max(1, Math.floor(20  / binHz));
    const b = Math.min(freq.length - 1, Math.ceil(200 / binHz));
    let sLow = 0;
    for (let i = a; i <= b; i++) sLow += freq[i];
    const lowEnergy = Math.min(1, (sLow / (b - a + 1)) / 255 * 1.8);

    // Total energy across the whole spectrum (with gentle high-end emphasis)
    let sTotal = 0;
    const half = Math.floor(freq.length * 0.85);
    for (let i = 1; i < half; i++) sTotal += freq[i];
    const totalEnergy = Math.min(1, (sTotal / half) / 255 * 2.4);

    // expose for UI hints (no audio detected)
    this.lastTotalEnergy = totalEnergy;

    const beat = this.detector.update(freq, this.audio.ctx.sampleRate, this.audio.analyser.fftSize, now);
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
      sampleRate: this.audio.ctx.sampleRate,
      fftSize: this.audio.analyser.fftSize,
    };

    if (this.mode === 'spectrum') drawSpectrum(this.ctx, this.W, this.H, freq, this.palette, opts);
    else if (this.mode === 'flash') drawFlash(this.ctx, this.W, this.H, this.palette, opts);
    else {
      tickParticles(this.W, this.H, this.palette, opts);
      drawParticles(this.ctx, this.W, this.H);
    }

    // FPS tracking + dynamic particle ceiling
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
    }
    this._lastFrameT = t;
  }
}

/* ----- hue rotation helper ----- */
function hueShift(hex, deg){
  const m = String(hex).replace('#','').match(/[0-9a-f]{6}/i);
  if (!m) return hex;
  const v = parseInt(m[0], 16);
  let r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
  // RGB -> HSL
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
  // HSL -> RGB
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
