/* lofy — Beat / BPM detection
   Energy-based onset detection on the low frequency band.
   Maintains a rolling buffer of ~1.4s and fires a beat when current
   low-band energy exceeds (avg * threshold). Tuned to fire reliably
   on real music while ignoring constant noise. */

export class BeatDetector {
  constructor(){
    this.buf = new Float32Array(43);
    this.bufIx = 0;
    this.lastBeatMs = 0;
    this.minIntervalMs = 160;       // hard floor — allows up to ~375 BPM
    this.strobeMinMs = 333;         // 3Hz cap when strobe guard on
    this.threshold = 1.25;          // energy must exceed avg by this factor
    this.energyFloor = 0.02;        // ignore near-silence
    this.strobeGuard = false;
    this.intervals = [];            // recent inter-beat intervals (ms)
    this.bpm = 0;
    this.manualBpm = 0;             // > 0 = override; visualizer uses this cadence
    this._manualNextBeat = 0;       // ms timestamp of next emitted beat
  }

  setManualBpm(n){
    this.manualBpm = (n > 0) ? n : 0;
    this._manualNextBeat = 0;
  }

  setStrobeGuard(on){ this.strobeGuard = !!on; }

  reset(){
    this.buf.fill(0); this.bufIx = 0;
    this.intervals.length = 0; this.bpm = 0;
    this.lastBeatMs = 0;
  }

  // freqData: Uint8Array (0..255), nowMs: performance.now()
  update(freqData, sampleRate, fftSize, nowMs){
    // Manual override — emit beats at a fixed cadence regardless of audio.
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
    const lo = 40, hi = 180;        // tight kick-drum band
    const binHz = sampleRate / fftSize;
    const startBin = Math.max(1, Math.floor(lo / binHz));
    const endBin = Math.min(freqData.length - 1, Math.ceil(hi / binHz));

    let sum = 0, peak = 0;
    for (let i = startBin; i <= endBin; i++){
      sum += freqData[i];
      if (freqData[i] > peak) peak = freqData[i];
    }
    // Use peak-weighted energy — kick drums show as sharp spikes
    const energy = (sum / Math.max(1, endBin - startBin + 1) * 0.6 + peak * 0.4) / 255;

    // rolling average
    let avg = 0;
    for (let i = 0; i < this.buf.length; i++) avg += this.buf[i];
    avg /= this.buf.length;

    this.buf[this.bufIx] = energy;
    this.bufIx = (this.bufIx + 1) % this.buf.length;

    const cooldown = this.strobeGuard ? this.strobeMinMs : this.minIntervalMs;
    const trigger = energy > this.energyFloor
      && (avg < 0.001 ? energy > 0.08 : energy > avg * this.threshold)
      && (nowMs - this.lastBeatMs) > cooldown;

    if (trigger){
      const dt = nowMs - this.lastBeatMs;
      if (this.lastBeatMs && dt < 2000){
        this.intervals.push(dt);
        if (this.intervals.length > 8) this.intervals.shift();
        const sorted = [...this.intervals].sort((a,b)=>a-b);
        const med = sorted[Math.floor(sorted.length/2)];
        const bpm = Math.round(60000 / med);
        if (bpm >= 60 && bpm <= 200) this.bpm = bpm;
      }
      this.lastBeatMs = nowMs;
      return true;
    }
    return false;
  }
}
