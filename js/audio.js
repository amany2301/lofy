/* lofy — Audio engine
   AudioContext + AnalyserNode + source switching (mic, file, tab capture).
   All processing local. No network. */

export const FFT_SIZE = 2048;

export class AudioEngine {
  constructor(){
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this.source = null;
    this.sourceType = null;  // 'mic' | 'file' | 'tab' | null
    this.stream = null;
    this.buffer = null;
    this.bufferNode = null;
    this.audioEl = null;
    this.elSource = null;
    this.fileName = null;
    this.sensitivity = 5;
    this.freqData = null;
    this.timeData = null;
    this.onTrackInfo = null;     // (name, duration) cb
    this.onPlayState = null;     // (isPlaying) cb
    this._fileStartTime = 0;
    this._fileOffset = 0;
    this._filePlaying = false;
  }

  _ensureContext(){
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._gainFromSensitivity(this.sensitivity);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = FFT_SIZE;
    this.analyser.smoothingTimeConstant = 0.8;
    this.gain.connect(this.analyser);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    this.timeData = new Uint8Array(this.analyser.fftSize);
  }

  _gainFromSensitivity(s){
    // 1..10  -> 0.5..3
    return 0.5 + ((s - 1) / 9) * 2.5;
  }

  setSensitivity(s){
    this.sensitivity = s;
    if (this.gain) this.gain.gain.value = this._gainFromSensitivity(s);
  }

  async resume(){
    this._ensureContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  getFrequencyData(){
    if (!this.analyser) return null;
    this.analyser.getByteFrequencyData(this.freqData);
    return this.freqData;
  }
  getTimeData(){
    if (!this.analyser) return null;
    this.analyser.getByteTimeDomainData(this.timeData);
    return this.timeData;
  }

  _disconnectSource(){
    try { if (this.source) this.source.disconnect(); } catch {}
    try { if (this.bufferNode) this.bufferNode.disconnect(); } catch {}
    try { if (this.elSource) this.elSource.disconnect(); } catch {}
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
      try { this.bufferNode.stop(); } catch {}
      this.bufferNode = null;
    }
    this.source = null;
    this.elSource = null;
    this._filePlaying = false;
    this.fileName = null;
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
    this.source.connect(this.gain);
    this.sourceType = 'mic';
    // Mic does NOT pipe to destination (would cause feedback)
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
    // Stop video tracks immediately — we only want audio
    stream.getVideoTracks().forEach(t => t.stop());
    const audioOnly = new MediaStream(audioTracks);
    this.stream = audioOnly;
    this.source = this.ctx.createMediaStreamSource(audioOnly);
    this.source.connect(this.gain);
    // Also route to speakers so the user can hear what's being captured
    this.source.connect(this.ctx.destination);
    this.sourceType = 'tab';
  }

  async useFile(file){
    await this.resume();
    this._disconnectSource();
    const buf = await file.arrayBuffer();
    let audioBuffer;
    try {
      audioBuffer = await this.ctx.decodeAudioData(buf);
    } catch(err){
      throw new Error('Unsupported file format. Try MP3, WAV, or OGG.');
    }
    this.buffer = audioBuffer;
    this.fileName = file.name;
    this.sourceType = 'file';
    this._fileOffset = 0;
    this._startBufferAt(0);
    if (this.onTrackInfo) this.onTrackInfo(file.name, audioBuffer.duration);
  }

  _startBufferAt(offsetSec){
    if (this.bufferNode){
      try { this.bufferNode.onended = null; this.bufferNode.stop(); } catch {}
      this.bufferNode = null;
    }
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.connect(this.gain);
    node.connect(this.ctx.destination);  // play out loud for file mode
    node.start(0, offsetSec);
    node.onended = () => {
      // natural end vs manual stop
      if (this.bufferNode === node){
        this._filePlaying = false;
        if (this.onPlayState) this.onPlayState(false);
      }
    };
    this.bufferNode = node;
    this._fileStartTime = this.ctx.currentTime - offsetSec;
    this._fileOffset = offsetSec;
    this._filePlaying = true;
    if (this.onPlayState) this.onPlayState(true);
  }

  filePlayPause(){
    if (this.sourceType !== 'file' || !this.buffer) return;
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
      return Math.min(this.buffer.duration, this.ctx.currentTime - this._fileStartTime);
    }
    return this._fileOffset;
  }

  fileDuration(){
    return this.buffer ? this.buffer.duration : 0;
  }

  isFilePlaying(){ return this._filePlaying; }
}
