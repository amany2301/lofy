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
import { drawWaveform, onBeatWaveform, resetWaveform } from './modes/waveform.js';
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

    // Party Rooms — guest follower mode
    this.followerMode = false;
    this._followTotalEnergy = 0;
    this._followLowEnergy = 0;
    this._followBpm = 0;
    this._followLastBeatLocalT = 0;       // local performance.now() of last received beat
    this._followFakeFreqData = null;       // synthetic Uint8Array for guest-side spectrum
    this._followFakeTimeData = null;       // synthetic Uint8Array for guest-side waveform
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
    resetSpectrum(); resetFlash(); resetParticles(); resetWaveform();
    this.ctx.fillStyle = '#0a0a0d';
    this.ctx.fillRect(0, 0, this.W, this.H);
  }

  // ─── Party Rooms — follower mode ────────────────────────────────────
  // Guests run the same render loop but skip local FFT analysis and
  // instead consume beat/state events received from the host over the
  // WebRTC data channel.

  setFollowerMode(on){
    this.followerMode = !!on;
    if (on){
      // Allocate fake FFT buffers once so spectrum / waveform have
      // something plausible to draw between beats.
      this._followFakeFreqData = new Uint8Array(1024);
      this._followFakeTimeData = new Uint8Array(2048);
    } else {
      this._followFakeFreqData = null;
      this._followFakeTimeData = null;
      this._followTotalEnergy = 0;
      this._followLowEnergy = 0;
      this._followBpm = 0;
    }
  }

  /** Host sent us a beat — fire the visual beat slam + bump energy. */
  followBeat(payload){
    if (!this.followerMode) return;
    const { bpm, energy = 0, lowEnergy = 0 } = payload || {};
    this._followBpm = bpm | 0;
    this._followTotalEnergy = Math.max(this._followTotalEnergy, Math.min(1, energy));
    this._followLowEnergy   = Math.max(this._followLowEnergy,   Math.min(1, lowEnergy));
    this._followLastBeatLocalT = performance.now();
    this._lastBeatEnergy = lowEnergy;
    // Same triggers the local detector would have fired — keeps every
    // mode reactive without needing audio.
    onBeatFlash(this.palette);
    onBeatParticles(this.W, this.H, this.palette, lowEnergy);
    onBeatWaveform(this.palette);
    if (this.onBeat) this.onBeat(this._followBpm);
  }

  /** Host sent us a state change — apply it to local state. */
  followState(payload){
    if (!this.followerMode) return;
    if (payload.mode && payload.mode !== this.mode) this.setMode(payload.mode);
    if (Array.isArray(payload.palette)) this.setPalette(payload.palette);
    if (payload.react != null) this.setReactivity(payload.react);
    // sens is a no-op for guests — they have no audio analyser to scale.
  }

  /** Fill the fake freq/time buffers with energy-driven random data so
   *  Spectrum and Waveform modes have something to render on the guest. */
  _synthesizeFakeData(now){
    const total = this._followTotalEnergy;
    const low   = this._followLowEnergy;

    // Synthetic spectrum — low bins are loud right after a beat, then decay
    const freq = this._followFakeFreqData;
    for (let i = 0; i < freq.length; i++){
      const t = i / freq.length;
      // log-falloff so low end dominates, like real music
      const base = total * (1 - t * 0.7);
      // sub-band kick boost near beat
      const kick = (t < 0.05 ? low * 0.8 : 0);
      const wobble = Math.random() * 0.18 * base;
      freq[i] = Math.min(255, (base + kick + wobble) * 255) | 0;
    }

    // Synthetic time-domain — sine stack pulsing with total energy
    const tt = this._followFakeTimeData;
    const phase = now * 0.002 * (1 + total * 0.4);
    const bpm = Math.max(60, this._followBpm || 120);
    const beatHz = bpm / 60;
    for (let i = 0; i < tt.length; i++){
      const ph = phase + i * 0.015;
      const v = Math.sin(ph) * 0.45
              + Math.sin(ph * 2.13 + total * 2) * 0.18
              + Math.sin(ph * 3.7 * beatHz / 2) * 0.10;
      tt[i] = 128 + (v * total * 80 | 0);
    }
  }

  /** Decay the synthetic energy envelopes between beats so the visual
   *  breathes naturally even when network silence happens. */
  _decayFollowerEnergy(){
    this._followTotalEnergy *= 0.94;
    this._followLowEnergy   *= 0.92;
  }
  // ────────────────────────────────────────────────────────────────────
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
    const now = performance.now();

    // ─── FOLLOWER MODE — no local audio, drive visuals from received events ───
    if (this.followerMode){
      this._renderFollower(t, now);
      this._tickFps(t);
      return;
    }

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
      onBeatWaveform(this.palette);
      if (this.onBeat) this.onBeat(this.detector.bpm);
    }

    // Waveform mode reads time-domain bytes; pre-fetch once per frame.
    const timeData = (this.mode === 'waveform' && this.audio.getTimeData)
      ? this.audio.getTimeData()
      : null;

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
      timeData,
      now,
    };

    if      (this.mode === 'spectrum') drawSpectrum(this.ctx, this.W, this.H, freq, this.palette, opts);
    else if (this.mode === 'flash')    drawFlash(this.ctx, this.W, this.H, this.palette, opts);
    else if (this.mode === 'waveform') drawWaveform(this.ctx, this.W, this.H, this.palette, opts);
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

    this._tickFps(t);
  }

  // ─── Render path for guests (follower mode) ───
  _renderFollower(t, now){
    // Decay envelopes for natural-feeling visuals between received beats
    this._decayFollowerEnergy();
    this._synthesizeFakeData(now);

    const freq = this._followFakeFreqData;
    const timeData = this._followFakeTimeData;

    // Hue rotation works the same way for guests (palette-driven, not audio-driven)
    if (this.hueRotate && this._basePalette){
      const lastT = this._lastHueT || now;
      const dt = now - lastT;
      this._lastHueT = now;
      const speed = 0.4 + Math.min(1.2, this._followTotalEnergy * 2.0);
      this._hueRotatePhase += dt / (this.hueCycleSec * 1000) * 360 * speed;
      this._hueRotatePhase %= 360;
      this.palette = this._basePalette.map(hex => hueShift(hex, this._hueRotatePhase));
    }

    // Use the host's last reported BPM for the BPM badge animation
    this.totalEnergyEma += (this._followTotalEnergy - this.totalEnergyEma)
      * (this._followTotalEnergy > this.totalEnergyEma ? 0.35 : 0.08);
    this.lastTotalEnergy = this._followTotalEnergy;

    const opts = {
      gain: 1,
      strobeGuard: this.strobeGuard,
      intensityScale: this._intensityScale(),
      reactivity: this.reactivity,
      lowEnergy: this._followLowEnergy,
      totalEnergy: this._followTotalEnergy,
      freqData: freq,
      sampleRate: 44100,
      fftSize: 2048,
      party: this.party,
      partyStrobeMs: this.partyStrobeMs,
      partyStart: this._partyStart,
      timeData,
      now,
    };

    if      (this.mode === 'spectrum') drawSpectrum(this.ctx, this.W, this.H, freq, this.palette, opts);
    else if (this.mode === 'flash')    drawFlash(this.ctx, this.W, this.H, this.palette, opts);
    else if (this.mode === 'waveform') drawWaveform(this.ctx, this.W, this.H, this.palette, opts);
    else {
      tickParticles(this.W, this.H, this.palette, opts);
      drawParticles(this.ctx, this.W, this.H);
    }

    if (this._bumpAlpha > 0.005){
      this.ctx.fillStyle = this._bumpColor;
      this.ctx.globalAlpha = this._bumpAlpha;
      this.ctx.fillRect(0, 0, this.W, this.H);
      this.ctx.globalAlpha = 1;
      this._bumpAlpha *= 0.78;
    }
  }

  // ─── FPS tracking + adaptive particle ceiling ───
  _tickFps(t){
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
