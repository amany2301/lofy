/* lofy — entry point. Wires audio engine, visualizer, controls. */
import { AudioEngine } from './audio.js';
import { Visualizer } from './visualizer.js';
import { Controls } from './controls.js';
import { paletteById } from './palettes.js';
import { loadSettings, hasAckEpilepsy, ackEpilepsy, loadLastState, saveLastState } from './presets.js';
import { getDemoBuffer } from './demo-audio.js';
import { encodeState, decodeState } from './share.js';
import { Recorder } from './recorder.js';

const canvas = document.getElementById('viz');
const bpmVal = document.getElementById('bpmVal');
const idleHint = document.getElementById('idleHint');
const toast = document.getElementById('toast');

const audio = new AudioEngine();
const viz = new Visualizer(canvas, audio);
const recorder = new Recorder({
  canvas,
  audio,
  onState: (rec) => {
    document.getElementById('btnRec')?.classList.toggle('rec-active', rec);
  },
  onToast: (msg, type) => showToast(msg, type),
});
const controls = new Controls({
  audio, viz,
  onSourceChange: (src) => {
    saveLast();
    idleHint.classList.remove('show');
  },
  onError: (msg) => showToast(msg, 'warn'),
  onToast: (msg, type) => showToast(msg, type),
});

// audio engine -> UI feedback
audio.onTrackInfo = (name, dur) => {};
audio.onPlayState = (playing) => {
  const btn = document.getElementById('btnPlay');
  if (btn) btn.textContent = playing ? '❚❚' : '▶';
};

viz.onBeat = (bpm) => {
  if (bpm && bpmVal) bpmVal.textContent = bpm;
  // Sync the metronome-dot pulse rate to the actual BPM
  if (bpm){
    const badge = document.getElementById('bpmBadge');
    if (badge) badge.style.setProperty('--bpm-beat-ms', (60000 / bpm) + 'ms');
  }
};
viz.onFps = (fps) => {
  const el = document.getElementById('fpsVal');
  if (el) el.textContent = fps;
};

// settings load + initial palette
const settings = loadSettings();
viz.setStrobeGuard(settings.strobeGuard);
viz.setIntensity(settings.colorIntensity);

// last state restoration — or hydrate from share URL hash (preset link)
const shareState = decodeState(location.hash);
const last = loadLastState();
if (shareState){
  if (shareState.mode){ viz.setMode(shareState.mode); controls.activeMode = shareState.mode; }
  if (shareState.palette){
    viz.setPalette(shareState.palette);
    controls.activePaletteId = 'share';
  }
  if (shareState.sens){
    settings.sensitivity = shareState.sens;
    audio.setSensitivity(shareState.sens);
  }
  if (shareState.react){
    settings.reactivity = shareState.react;
    viz.setReactivity(shareState.react);
  }
} else if (last){
  if (last.mode) { viz.setMode(last.mode); controls.activeMode = last.mode; }
  if (last.paletteId){
    const p = paletteById(last.paletteId);
    viz.setPalette(p);                                  // pass full preset
    controls.activePaletteId = p.id;
  }
} else {
  // default
  const p = paletteById('lofy-default');
  viz.setPalette(p);
  viz.setMode('spectrum');
}

// Apply persisted hue/FPS settings
if (settings.hueRotate) viz.setHueRotate(true, settings.hueCycleSec || 45);
if (settings.showFps) document.getElementById('fpsChip')?.classList.add('show');

// Demo audio — play synthesised 128 BPM loop without mic permission
async function playDemo(opts = {}){
  const { silent = false } = opts;
  try {
    if (!silent) showToast('Loading demo loop…', 'ok');
    const buf = await getDemoBuffer();
    audio.useDemo(buf, 'Demo Loop · 128 BPM');
    idleHint.classList.remove('show');
    document.getElementById('trackbar')?.classList.add('show');
    const tn = document.getElementById('trackName');
    if (tn) tn.textContent = 'Demo Loop · 128 BPM';
    controls._setActivePill('srcGroup', 'src', 'demo');
    controls.activeSource = 'demo';
    if (!silent) showToast('Demo playing — switch to Mic / File / Tab anytime', 'ok');
  } catch (err){
    if (!silent) showToast('Demo failed: ' + (err.message || err), 'warn');
  }
}

window.__lofy_playDemo = playDemo;

// Detect iOS Safari — Web Audio is muted until user gesture
function isIosAudioSuspended(){
  const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  return isIos && audio.ctx && audio.ctx.state === 'suspended';
}
function maybeShowIosUnmuteToast(){
  if (isIosAudioSuspended()){
    showToast('Tap the canvas to unmute audio', 'warn');
    // Wire one-shot unmute on the next tap anywhere
    const unmute = () => {
      audio.resume();
      window.removeEventListener('pointerdown', unmute, true);
    };
    window.addEventListener('pointerdown', unmute, true);
  }
}

// First launch epilepsy warning — demo plays BEHIND the modal so the
// canvas is already alive when the user clicks "Got it".
function showFirstLaunch(){
  if (hasAckEpilepsy()) return;
  const fl = document.getElementById('firstLaunch');
  fl.style.display = 'flex';
  // Auto-start the demo silently — first-impression magic
  playDemo({ silent: true });
  document.getElementById('ackBtn').addEventListener('click', async () => {
    ackEpilepsy();
    fl.style.display = 'none';
    try {
      await audio.useMic();
      idleHint.classList.remove('show');
    } catch (err){
      // Mic blocked — keep the demo playing
      await playDemo({ silent: true });
      showToast('Mic blocked — playing the demo instead', 'warn');
    }
  }, { once:true });
  const tryDemoModalBtn = document.getElementById('tryDemoModalBtn');
  if (tryDemoModalBtn){
    tryDemoModalBtn.addEventListener('click', async () => {
      ackEpilepsy();
      fl.style.display = 'none';
      // demo already playing — just update toast
      showToast('Demo playing — switch to Mic / File / Tab anytime', 'ok');
    }, { once:true });
  }
}

function autoStart(){
  if (!hasAckEpilepsy()){
    showFirstLaunch();
    return;
  }
  // Returning user: try mic first; if blocked or quiet, fall back to demo.
  audio.useMic()
    .then(() => {
      idleHint.classList.remove('show');
      maybeShowIosUnmuteToast();
    })
    .catch(async () => {
      await playDemo({ silent: true });
      showToast('Mic blocked — playing the demo instead', 'warn');
    });
}

controls.init();
controls._applySettingsToUI();
controls._renderSwatches();

// Idle-hint demo button
document.getElementById('tryDemoBtn')?.addEventListener('click', () => playDemo());

// expose recorder toggle so controls.js keyboard binding (R) works
controls._toggleRecording = () => recorder.toggle();
// Disable Rec button if MediaRecorder + captureStream aren't supported
if (!recorder.isSupported()){
  const btnRec = document.getElementById('btnRec');
  if (btnRec){
    btnRec.setAttribute('aria-disabled', 'true');
    btnRec.classList.add('disabled');
    btnRec.title = 'Recording not supported on this browser';
  }
}

// Sync mode + source pill highlight with restored / default state.
// Replaces a buggy plain classList.add — that left Spectrum's hardcoded
// "active" class in place when last-state restored a different mode,
// resulting in TWO pills appearing selected at once.
controls._setActivePill('modeGroup', 'mode', controls.activeMode);
controls._setActivePill('srcGroup', 'src', controls.activeSource);

viz.start();
autoStart();

// idle hint trigger (no audio for 5s)
let silenceFrames = 0;
setInterval(() => {
  if (!audio.analyser) return;
  const f = audio.getFrequencyData();
  let sum = 0;
  for (let i = 0; i < f.length; i++) sum += f[i];
  if (sum < 200){
    silenceFrames++;
    if (silenceFrames > 5) idleHint.classList.add('show');
  } else {
    silenceFrames = 0;
    idleHint.classList.remove('show');
  }
}, 1000);

function saveLast(){
  saveLastState({
    sourceType: audio.sourceType,
    mode: controls.activeMode,
    paletteId: controls.activePaletteId,
  });
}

function showToast(msg, type){
  toast.textContent = msg;
  toast.className = 'toast show' + (type === 'ok' ? ' ok' : type === 'warn' ? ' warn' : '');
  setTimeout(() => toast.classList.remove('show'), 2800);
}

// Persist state on changes
const _origSetMode = controls.setMode.bind(controls);
controls.setMode = (m) => { _origSetMode(m); saveLast(); };
const _origSetPal = controls.setPalette.bind(controls);
controls.setPalette = (p) => { _origSetPal(p); saveLast(); };

// Window unload
window.addEventListener('beforeunload', saveLast);

/* ============================================================
   v1.3 additions — install prompt, SW updates, first-time kbd hint
   ============================================================ */

const SEEN_KBD_HINT_KEY = 'lofy_seen_kbd_hint';

// Install PWA pill — captured from beforeinstallprompt
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  const pill = document.getElementById('installPill');
  if (pill) pill.hidden = false;
});
document.getElementById('installBtn')?.addEventListener('click', async () => {
  if (!_deferredInstallPrompt) return;
  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;
  _deferredInstallPrompt = null;
  document.getElementById('installPill').hidden = true;
  if (outcome === 'accepted') showToast('lofy installed · launch from your home screen', 'ok');
});
window.addEventListener('appinstalled', () => {
  document.getElementById('installPill').hidden = true;
});

// Service worker — listen for controllerchange (new version activated)
let _swUpdateNotified = false;
if ('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (_swUpdateNotified) return;
    _swUpdateNotified = true;
    showToast('Updated · reload to load the new version', 'ok');
  });
}

// First-time keyboard hint
function maybeShowKbdHint(){
  if (!hasAckEpilepsy()) return;
  try {
    if (localStorage.getItem(SEEN_KBD_HINT_KEY)) return;
  } catch {}
  setTimeout(() => {
    showToast('Press ? for shortcuts · F for fullscreen', 'ok');
    try { localStorage.setItem(SEEN_KBD_HINT_KEY, '1'); } catch {}
  }, 4500);
}

maybeShowKbdHint();
