/* lofy — Audio engine (v1.2 — DSP-correct pipeline)
   AudioContext with two parallel branches:

     source ─┬─▶ gain ─▶ destination (listening, untouched, unity-gain)
             └─▶ hpFilter ─▶ compressor ─▶ analyser     (spectrum, smooth)
                                       └─▶ analyserBeat (beats, snappy)

   The analysis branch is fully isolated from the listening signal so:
   - Sensitivity slider doesn't distort what the user actually hears.
   - The compressor levels the visual response without coloring the audio.
   - A high-pass removes DC / sub-rumble that would inflate fake bass energy.
   - Two analysers have different smoothing/FFT trade-offs — spectrum prefers
     0.85 (creamy bars), beat detection prefers 0.4 (sharp transients).

   Sensitivity is now applied POST-FFT (multiplying the byte-frequency array)
   instead of pre-FFT, so high sens settings never saturate the analyser.
*/

export const FFT_SIZE_SPECTRUM = 2048;
export const FFT_SIZE_BEAT     = 1024;

export class AudioEngine {
  constructor(){
    this.ctx = null;
    this.gain = null;            // unity-gain passthrough for listening branch
    this.hpFilter = null;        // high-pass on analysis branch
    this.compressor = null;      // analysis-only dynamics compression
    this.analyser = null;        // spectrum (FFT 2048, smoothing 0.85)
    this.analyserBeat = null;    // beats (FFT 1024, smoothing 0.4)
    this.source = null;
    this.sourceType = null;      // 'mic' | 'file' | 'tab' | null
    this.stream = null;
    this.buffer = null;
    this.bufferNode = null;
    this.audioEl = null;
    this.elSource = null;
    this.fileName = null;
    this.sensitivity = 5;
    this._sensScale = 1;         // post-FFT magnitude multiplier
    this.freqData = null;
    this.freqDataBeat = null;
    this.timeData = null;
    this.onTrackInfo = null;
    this.onPlayState = null;
    this._fileStartTime = 0;
    this._fileOffset = 0;
    this._filePlaying = false;
    this._pendingStart = false;
    this._loop = false;
  }

  _ensureContext(){
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();

    // ---- listening branch (untouched, just unity-gain routing) ----
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;

    // ---- analysis branch ----
    // High-pass kills DC offset and sub-audible rumble (cheap mic problem).
    this.hpFilter = this.ctx.createBiquadFilter();
    this.hpFilter.type = 'highpass';
    this.hpFilter.frequency.value = 22;
    this.hpFilter.Q.value = 0.7;

    // Compressor evens out dynamics WITHIN the analysis branch only.
    // Loud chorus → quiet verse no longer collapses the visual to nothing.
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -24;
    this.compressor.knee.value      = 8;
    this.compressor.ratio.value     = 6;
    this.compressor.attack.value    = 0.003;
    this.compressor.release.value   = 0.25;

    // Two analysers tap the post-compressor signal, each tuned for its job.
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize               = FFT_SIZE_SPECTRUM;
    this.analyser.smoothingTimeConstant = 0.85;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = -10;

    this.analyserBeat = this.ctx.createAnalyser();
    this.analyserBeat.fftSize               = FFT_SIZE_BEAT;
    this.analyserBeat.smoothingTimeConstant = 0.4;
    this.analyserBeat.minDecibels = -90;
    this.analyserBeat.maxDecibels = -10;

    // Wire the analysis branch
    this.hpFilter.connect(this.compressor);
    this.compressor.connect(this.analyser);
    this.compressor.connect(this.analyserBeat);

    this.freqData     = new Uint8Array(this.analyser.frequencyBinCount);
    this.freqDataBeat = new Uint8Array(this.analyserBeat.frequencyBinCount);
    this.timeData     = new Uint8Array(this.analyser.fftSize);
  }

  // Connect a source node to BOTH branches (listening + analysis).
  // Caller decides whether to also connect to ctx.destination (for playback).
  _attachSource(node){
    node.connect(this.gain);
    node.connect(this.hpFilter);
  }

  setSensitivity(s){
    this.sensitivity = s;
    // 1..10  →  0.5..3.0 (same range as before, applied post-FFT now)
    this._sensScale = 0.5 + ((s - 1) / 9) * 2.5;
  }

  async resume(){
    this._ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  getFrequencyData(){
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    if (this._sensScale !== 1){
      const s = this._sensScale;
      const d = this.freqData;
      for (let i = 0; i < d.length; i++){
        const v = d[i] * s;
        d[i] = v > 255 ? 255 : (v | 0);
      }
    }
    return this.freqData;
  }
  getBeatFrequencyData(){
    if (!this.analyserBeat) return null;
    this.analyserBeat.getByteFrequencyData(this.freqDataBeat);
    if (this._sensScale !== 1){
      const s = this._sensScale;
      const d = this.freqDataBeat;
      for (let i = 0; i < d.length; i++){
        const v = d[i] * s;
        d[i] = v > 255 ? 255 : (v | 0);
      }
    }
    return this.freqDataBeat;
  }
  getTimeData(){
    if (!this.analyser) return null;
    this.analyser.getByteTimeDomainData(this.timeData);
    return this.timeData;
  }

  _disconnectSource(){
    if (this.source)     { try { this.source.disconnect(); }     catch {} }
    if (this.bufferNode) { try { this.bufferNode.disconnect(); } catch {} }
    if (this.elSource)   { try { this.elSource.disconnect(); }   catch {} }
    if (this.stream){
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioEl){
      this.audioEl.pause();
      this.audioEl.src = '';
      this.audioEl = null;
    }
    if (this.bufferNode){
      try { this.bufferNode.onended = null; this.bufferNode.stop(); } catch {}
      this.bufferNode = null;
    }
    this.source = null;
    this.elSource = null;
    this._filePlaying = false;
    this._pendingStart = false;
    this._loop = false;
    this.fileName = null;
    this.buffer = null;
    if (this.onPlayState) this.onPlayState(false);
  }

  async useMic(){
    await this.resume();
    this._disconnectSource();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation:false, noiseSuppression:false, autoGainControl:false }
    });
    this.stream = stream;
    this.source = this.ctx.createMediaStreamSource(stream);
    this._attachSource(this.source);
    // Mic does NOT pipe to destination (would cause feedback)
    this.sourceType = 'mic';
  }

  async useTab(){
    await this.resume();
    this._disconnectSource();
    if (!navigator.mediaDevices.getDisplayMedia){
      throw new Error('Tab capture not supported in this browser. Try Chrome or Edge on desktop.');
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true });
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length){
      stream.getTracks().forEach(t => t.stop());
      throw new Error('No audio captured. When picking a tab, check "Share tab audio".');
    }
    // Detect whether the user shared the lofy tab itself — would create
    // an infinite acoustic feedback loop. Skip the destination route in
    // that case (analysis still works fine for self-capture, no howl).
    const sharedSelf = stream.getVideoTracks().some(t => {
      const label = (t.label || '').toLowerCase();
      return label.includes('lofy') || label.includes(location.host.toLowerCase());
    });
    stream.getVideoTracks().forEach(t => t.stop());

    const audioOnly = new MediaStream(audioTracks);
    this.stream = audioOnly;
    this.source = this.ctx.createMediaStreamSource(audioOnly);
    this._attachSource(this.source);
    if (!sharedSelf){
      // Pipe to speakers so the user hears what's being captured.
      this.source.connect(this.ctx.destination);
    }
    this.sourceType = 'tab';
    this.sharedSelf = sharedSelf;
  }

  async useFile(file){
    await this.resume();
    this._disconnectSource();
    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch {
      throw new Error('Could not read that file. Try a different one.');
    }
    let audioBuffer;
    try {
      audioBuffer = await this.ctx.decodeAudioData(buf);
    } catch {
      throw new Error('Unsupported file format. Try MP3, WAV, or OGG.');
    }
    this._useBuffer(audioBuffer, file.name, { loop: false, type: 'file' });
  }

  _useBuffer(audioBuffer, name, opts = {}){
    this.buffer = audioBuffer;
    this.fileName = name;
    this.sourceType = opts.type || 'file';
    this._loop = !!opts.loop;
    this._fileOffset = 0;
    this._startBufferAt(0);
    if (this.onTrackInfo) this.onTrackInfo(name, audioBuffer.duration);
  }

  useDemo(audioBuffer, label = 'Demo Loop · 128 BPM'){
    if (!this.ctx) this._ensureContext();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this._disconnectSource();
    this._useBuffer(audioBuffer, label, { loop: true, type: 'file' });
  }

  setFileLoop(on){
    this._loop = !!on;
    if (this.bufferNode) this.bufferNode.loop = !!on;
  }

  _startBufferAt(offsetSec){
    if (this._pendingStart) return;
    this._pendingStart = true;
    try {
      if (this.bufferNode){
        try { this.bufferNode.onended = null; this.bufferNode.stop(); } catch {}
        this.bufferNode = null;
      }
      const node = this.ctx.createBufferSource();
      node.buffer = this.buffer;
      node.loop = !!this._loop;
      this._attachSource(node);
      node.connect(this.ctx.destination);
      node.start(0, offsetSec);
      node.onended = () => {
        if (this.bufferNode === node && !this._loop){
          this._filePlaying = false;
          if (this.onPlayState) this.onPlayState(false);
        }
      };
      this.bufferNode = node;
      this._fileStartTime = this.ctx.currentTime - offsetSec;
      this._fileOffset = offsetSec;
      this._filePlaying = true;
      if (this.onPlayState) this.onPlayState(true);
    } finally {
      this._pendingStart = false;
    }
  }

  filePlayPause(){
    if (this.sourceType !== 'file' || !this.buffer || this._pendingStart) return;
    if (this._filePlaying){
      const cur = this.fileCurrentTime();
      this._fileOffset = cur;
      try { this.bufferNode.onended = null; this.bufferNode.stop(); } catch {}
      this.bufferNode = null;
      this._filePlaying = false;
      if (this.onPlayState) this.onPlayState(false);
    } else {
      this._startBufferAt(this._fileOffset);
    }
  }

  fileSeek(sec){
    if (this.sourceType !== 'file' || !this.buffer) return;
    sec = Math.max(0, Math.min(this.buffer.duration, sec));
    if (this._filePlaying){
      this._startBufferAt(sec);
    } else {
      this._fileOffset = sec;
    }
  }

  fileCurrentTime(){
    if (!this.buffer) return 0;
    if (this._filePlaying){
      const t = this.ctx.currentTime - this._fileStartTime;
      if (this._loop) return t % this.buffer.duration;
      return Math.min(this.buffer.duration, t);
    }
    return Math.min(this.buffer.duration, this._fileOffset);
  }

  fileDuration(){
    return this.buffer ? this.buffer.duration : 0;
  }

  isFilePlaying(){ return this._filePlaying; }
}

// Back-compat — some callers may import this from older code paths.
export const FFT_SIZE = FFT_SIZE_SPECTRUM;
