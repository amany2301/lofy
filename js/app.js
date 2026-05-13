/* lofy — entry point. Wires audio engine, visualizer, controls. */
import { AudioEngine } from './audio.js';
import { Visualizer } from './visualizer.js';
import { Controls } from './controls.js';
import { paletteById } from './palettes.js';
import { loadSettings, hasAckEpilepsy, ackEpilepsy, loadLastState, saveLastState } from './presets.js';

const canvas = document.getElementById('viz');
const bpmVal = document.getElementById('bpmVal');
const idleHint = document.getElementById('idleHint');
const toast = document.getElementById('toast');

const audio = new AudioEngine();
const viz = new Visualizer(canvas, audio);
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

// settings load + initial palette
const settings = loadSettings();
viz.setStrobeGuard(settings.strobeGuard);
viz.setIntensity(settings.colorIntensity);

// last state restoration
const last = loadLastState();
if (last){
  if (last.mode) { viz.setMode(last.mode); controls.activeMode = last.mode; }
  if (last.paletteId){
    const p = paletteById(last.paletteId);
    viz.setPalette(p.colors);
    controls.activePaletteId = p.id;
  }
} else {
  // default
  const p = paletteById('lofy-default');
  viz.setPalette(p.colors);
  viz.setMode('spectrum');
}

// First launch epilepsy warning
function showFirstLaunch(){
  if (hasAckEpilepsy()) return;
  const fl = document.getElementById('firstLaunch');
  fl.style.display = 'flex';
  document.getElementById('ackBtn').addEventListener('click', async () => {
    ackEpilepsy();
    fl.style.display = 'none';
    // try mic by default
    try {
      await audio.useMic();
      idleHint.classList.remove('show');
    } catch {
      // fallback — show idle hint
      idleHint.classList.add('show');
    }
  }, { once:true });
}

function autoStart(){
  if (!hasAckEpilepsy()){
    showFirstLaunch();
    return;
  }
  // user has acknowledged before — try mic
  audio.useMic()
    .then(() => idleHint.classList.remove('show'))
    .catch(() => idleHint.classList.add('show'));
}

controls.init();
controls._applySettingsToUI();
controls._renderSwatches();

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
