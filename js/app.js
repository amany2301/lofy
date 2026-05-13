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
async function playDemo(){
  try {
    showToast('Loading demo loop…', 'ok');
    const buf = await getDemoBuffer();
    audio.useDemo(buf, 'Demo Loop · 128 BPM');
    idleHint.classList.remove('show');
    document.getElementById('trackbar')?.classList.add('show');
    const tn = document.getElementById('trackName');
    if (tn) tn.textContent = 'Demo Loop · 128 BPM';
    // mark source pill so user knows what's playing
    controls._setActivePill('srcGroup', 'src', 'file');
    controls.activeSource = 'file';
    showToast('Demo playing — switch to Mic / File / Tab anytime', 'ok');
  } catch (err){
    showToast('Demo failed: ' + (err.message || err), 'warn');
  }
}

// expose for controls.js / inline handlers
window.__lofy_playDemo = playDemo;

// First launch epilepsy warning
function showFirstLaunch(){
  if (hasAckEpilepsy()) return;
  const fl = document.getElementById('firstLaunch');
  fl.style.display = 'flex';
  document.getElementById('ackBtn').addEventListener('click', async () => {
    ackEpilepsy();
    fl.style.display = 'none';
    try {
      await audio.useMic();
      idleHint.classList.remove('show');
    } catch (err){
      idleHint.classList.add('show');
      showToast('Mic blocked — try File or Tab source', 'warn');
    }
  }, { once:true });
  // Try-demo button inside the modal — no mic required
  const tryDemoModalBtn = document.getElementById('tryDemoModalBtn');
  if (tryDemoModalBtn){
    tryDemoModalBtn.addEventListener('click', async () => {
      ackEpilepsy();
      fl.style.display = 'none';
      await playDemo();
    }, { once:true });
  }
}

function autoStart(){
  if (!hasAckEpilepsy()){
    showFirstLaunch();
    return;
  }
  audio.useMic()
    .then(() => idleHint.classList.remove('show'))
    .catch((err) => {
      idleHint.classList.add('show');
      // Subtle hint; not a full toast (the user has seen the page before)
      showToast('Mic blocked — try File or Tab source', 'warn');
    });
}

controls.init();
controls._applySettingsToUI();
controls._renderSwatches();

// Idle-hint demo button
document.getElementById('tryDemoBtn')?.addEventListener('click', () => playDemo());

// expose recorder toggle so controls.js keyboard binding (R) works
controls._toggleRecording = () => recorder.toggle();

// Highlight default pills
document.querySelector('[data-mode="' + controls.activeMode + '"]')?.classList.add('active');

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
