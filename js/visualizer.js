/* lofy — Render loop + mode dispatcher */
import { drawSpectrum, resetSpectrum } from './modes/spectrum.js';
import { drawFlash, onBeatFlash, resetFlash } from './modes/flash.js';
import { drawParticles, onBeatParticles, resetParticles, setMaxParticles } from './modes/particles.js';
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
    resetFlash();
  }
  setIntensity(level){ this.intensity = level; }
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
    const now = performance.now();

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
    else drawParticles(this.ctx, this.W, this.H);

    // crude fps monitoring -> reduce particle ceiling if struggling
    if (this._lastFrameT){
      const dt = t - this._lastFrameT;
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
