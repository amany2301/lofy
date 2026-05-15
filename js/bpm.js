/* lofy — Beat / BPM detection (v1.2 — spectral-flux hybrid)
   Two detectors run in parallel and OR their outputs:

     1. Kick-band energy   — sharp low-frequency spikes (40–180 Hz)
        Best for: house, techno, hip-hop, anything with a clear kick.

     2. Spectral flux       — sum of positive frame-to-frame ΔFFT magnitude
        across all bins (half-wave rectified). Fires on ANY transient
        regardless of frequency: vocals, snares, hi-hats, plucks.
        Best for: ambient, lo-fi, vocal-heavy, acoustic — music that
        the kick-band detector silently misses.

   The OR keeps behavior on kick-driven music identical while adding
   detection coverage on everything else. Both share one cooldown so we
   never double-fire on the same transient.

   BPM tracking applies octave-correction (a 140 BPM track measured as
   70 — common half-time emphasis — is rescued) and jitter rejection
   (outlier intervals are discarded instead of polluting the median). */

export class BeatDetector {
  constructor(){
    // Kick-band detector state
    this.buf = new Float32Array(43);
    this.bufIx = 0;

    // Spectral-flux detector state
    this._prevFreq = null;
    this._fluxBuf = new Float32Array(43);
    this._fluxIx = 0;

    // Shared
    this.lastBeatMs = 0;
    this.minIntervalMs = 160;       // hard floor — up to ~375 BPM
    this.strobeMinMs = 333;         // 3 Hz cap when strobe guard on
    this.threshold = 1.25;          // kick-band threshold multiplier
    this.fluxThreshold = 1.6;       // spectral-flux threshold multiplier
    this.energyFloor = 0.02;        // kick-band floor
    this.fluxFloor = 0.01;          // flux floor
    this.strobeGuard = false;

    // BPM tracking
    this.intervals = [];
    this.bpm = 0;
    this.manualBpm = 0;
    this._manualNextBeat = 0;
  }

  setManualBpm(n){
    this.manualBpm = (n > 0) ? n : 0;
    this._manualNextBeat = 0;
  }
  setStrobeGuard(on){ this.strobeGuard = !!on; }

  reset(){
    this.buf.fill(0); this.bufIx = 0;
    this._fluxBuf.fill(0); this._fluxIx = 0;
    this._prevFreq = null;
    this.intervals.length = 0;
    this.bpm = 0;
    this.lastBeatMs = 0;
  }

  update(freqData, sampleRate, fftSize, nowMs){
    // Manual override — wall-clock beat emitter
    if (this.manualBpm){
      const period = 60000 / this.manualBpm;
      if (!this._manualNextBeat) this._manualNextBeat = nowMs;
      if (nowMs >= this._manualNextBeat){
        this._manualNextBeat += period;
        this.bpm = this.manualBpm;
        this.lastBeatMs = nowMs;
        return true;
      }
      return false;
    }
    if (!freqData) return false;

    const cooldown = this.strobeGuard ? this.strobeMinMs : this.minIntervalMs;
    const sinceBeat = nowMs - this.lastBeatMs;

    // ===== Kick-band detector =====
    const lo = 40, hi = 180;
    const binHz = sampleRate / fftSize;
    const startBin = Math.max(1, Math.floor(lo / binHz));
    const endBin = Math.min(freqData.length - 1, Math.ceil(hi / binHz));
    let sum = 0, peak = 0;
    for (let i = startBin; i <= endBin; i++){
      sum += freqData[i];
      if (freqData[i] > peak) peak = freqData[i];
    }
    const energy = (sum / Math.max(1, endBin - startBin + 1) * 0.6 + peak * 0.4) / 255;

    let kickAvg = 0;
    for (let i = 0; i < this.buf.length; i++) kickAvg += this.buf[i];
    kickAvg /= this.buf.length;
    this.buf[this.bufIx] = energy;
    this.bufIx = (this.bufIx + 1) % this.buf.length;

    const kickFired = energy > this.energyFloor
      && (kickAvg < 0.001 ? energy > 0.08 : energy > kickAvg * this.threshold)
      && sinceBeat > cooldown;

    // ===== Spectral-flux detector =====
    if (!this._prevFreq || this._prevFreq.length !== freqData.length){
      this._prevFreq = new Uint8Array(freqData.length);
    }
    let flux = 0;
    for (let i = 1; i < freqData.length; i++){
      const d = freqData[i] - this._prevFreq[i];
      if (d > 0) flux += d;
    }
    this._prevFreq.set(freqData);
    const fluxNorm = flux / freqData.length / 255;

    let fluxAvg = 0;
    for (let i = 0; i < this._fluxBuf.length; i++) fluxAvg += this._fluxBuf[i];
    fluxAvg /= this._fluxBuf.length;
    this._fluxBuf[this._fluxIx] = fluxNorm;
    this._fluxIx = (this._fluxIx + 1) % this._fluxBuf.length;

    const fluxFired = fluxNorm > this.fluxFloor
      && (fluxAvg < 0.0005 ? fluxNorm > 0.04 : fluxNorm > fluxAvg * this.fluxThreshold)
      && sinceBeat > cooldown;

    // ===== OR + BPM tracking =====
    if (kickFired || fluxFired){
      const dt = sinceBeat;
      if (this.lastBeatMs && dt < 2000){
        // Jitter rejection: ignore intervals wildly outside the running median.
        if (this.intervals.length >= 3){
          const sortedNow = [...this.intervals].sort((a,b)=>a-b);
          const medNow = sortedNow[Math.floor(sortedNow.length/2)];
          // Skip if > 65% deviation from current median — likely a spurious double or skipped beat
          if (medNow > 0){
            const dev = Math.abs(dt - medNow) / medNow;
            if (dev > 0.65){
              this.lastBeatMs = nowMs;     // still record the beat, just don't trust the interval
              return true;
            }
          }
        }
        this.intervals.push(dt);
        if (this.intervals.length > 8) this.intervals.shift();
        // Require ≥ 4 intervals before reporting BPM (more stable display)
        if (this.intervals.length >= 4){
          const sorted = [...this.intervals].sort((a,b)=>a-b);
          const med = sorted[Math.floor(sorted.length/2)];
          let bpm = Math.round(60000 / med);
          // Octave correction
          if (bpm > 0 && bpm < 85){
            const doubled = Math.round(60000 / (med / 2));
            if (doubled >= 100 && doubled <= 180) bpm = doubled;
          } else if (bpm > 180){
            const halved = Math.round(60000 / (med * 2));
            if (halved >= 80 && halved <= 160) bpm = halved;
          }
          if (bpm >= 60 && bpm <= 200) this.bpm = bpm;
        }
      }
      this.lastBeatMs = nowMs;
      return true;
    }
    return false;
  }
}
