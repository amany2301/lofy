/* lofy — 30-second canvas recorder
   Uses canvas.captureStream() + MediaRecorder to write a WebM clip.
   Audio is captured only when an AudioContext destination MediaStream is
   available (file/demo/tab modes). Mic mode records video only to avoid
   feedback loops. */

const CLIP_SECONDS = 30;
const COUNTDOWN = 3;

function pickMime(){
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm',
    'video/mp4',
  ];
  for (const m of candidates){
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class Recorder {
  constructor({ canvas, audio, onState, onToast }){
    this.canvas = canvas;
    this.audio = audio;
    this.onState = onState || (()=>{});
    this.onToast = onToast || (()=>{});
    this.recorder = null;
    this.chunks = [];
    this._stopT = 0;
  }

  isSupported(){
    return typeof window !== 'undefined'
      && !!window.MediaRecorder
      && typeof this.canvas.captureStream === 'function';
  }

  async toggle(){
    if (this.recorder && this.recorder.state === 'recording'){
      this.stop();
      return;
    }
    if (!this.isSupported()){
      this.onToast('Recording not supported in this browser', 'warn');
      return;
    }
    await this._startWithCountdown();
  }

  async _startWithCountdown(){
    const cd = document.getElementById('countdown');
    const cdN = document.getElementById('countdownN');
    if (cd && cdN){
      cd.classList.add('show');
      for (let i = COUNTDOWN; i >= 1; i--){
        cdN.textContent = String(i);
        await new Promise(r => setTimeout(r, 700));
      }
      cd.classList.remove('show');
    }
    this._start();
  }

  _start(){
    const mime = pickMime();
    if (!mime){
      this.onToast('No supported video codec — try Chrome', 'warn');
      return;
    }
    const videoStream = this.canvas.captureStream(60);
    // Try to add audio if we have an AudioContext-based source we control
    let combined = videoStream;
    try {
      if (this.audio?.ctx && this.audio?.gain
          && (this.audio.sourceType === 'file' || this.audio.sourceType === 'tab')){
        const dest = this.audio.ctx.createMediaStreamDestination();
        this.audio.gain.connect(dest);
        const audioTrack = dest.stream.getAudioTracks()[0];
        if (audioTrack){
          combined = new MediaStream([
            ...videoStream.getVideoTracks(),
            audioTrack,
          ]);
          this._audioTap = { dest };
        }
      }
    } catch {}

    try {
      this.recorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    } catch (err){
      this.onToast('Recording failed to start', 'warn');
      return;
    }
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.recorder.onstop = () => this._finalize(mime);

    this.recorder.start();
    this.onState(true);
    this.onToast('Recording 30s…', 'ok');
    this._stopT = setTimeout(() => this.stop(), CLIP_SECONDS * 1000);
  }

  stop(){
    if (this._stopT){ clearTimeout(this._stopT); this._stopT = 0; }
    if (this.recorder && this.recorder.state !== 'inactive'){
      try { this.recorder.stop(); } catch {}
    }
    this.onState(false);
    if (this._audioTap){
      try { this.audio.gain.disconnect(this._audioTap.dest); } catch {}
      this._audioTap = null;
    }
  }

  _finalize(mime){
    if (!this.chunks.length){
      this.onToast('No clip captured', 'warn');
      return;
    }
    const blob = new Blob(this.chunks, { type: mime });
    const url = URL.createObjectURL(blob);
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const a = document.createElement('a');
    a.href = url;
    a.download = `lofy-clip-${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
    this.onToast('Clip saved · check your downloads', 'ok');
  }
}
