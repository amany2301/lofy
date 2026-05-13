/* lofy — preset & settings storage */

const K_SETTINGS = 'lofy_settings';
const K_PRESETS  = 'lofy_presets';
const K_LAST     = 'lofy_last_state';
const K_ACK      = 'lofy_epilepsy_ack';

export const DEFAULT_SETTINGS = {
  sensitivity: 5,
  reactivity: 7,        // color reactivity (1..10)
  strobeGuard: true,    // default ON per PRD recommendation
  showBpm: true,
  colorIntensity: 'med',
  autoHide: true,
  shortcuts: true,
  hueRotate: false,
  hueCycleSec: 45,
  showFps: false,
};

function safeParse(s, fallback){
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

export function loadSettings(){
  const s = safeParse(localStorage.getItem(K_SETTINGS), {});
  return { ...DEFAULT_SETTINGS, ...s };
}

export function saveSettings(s){
  try { localStorage.setItem(K_SETTINGS, JSON.stringify(s)); } catch {}
}

export function loadPresets(){
  return safeParse(localStorage.getItem(K_PRESETS), []);
}

export function savePreset(preset){
  const arr = loadPresets();
  arr.push({ ...preset, id: 'u-' + Date.now(), createdAt: new Date().toISOString() });
  try {
    localStorage.setItem(K_PRESETS, JSON.stringify(arr));
    return true;
  } catch (err){
    return false;       // quota exceeded
  }
}

export function deletePreset(id){
  const arr = loadPresets().filter(p => p.id !== id);
  try { localStorage.setItem(K_PRESETS, JSON.stringify(arr)); return true; }
  catch { return false; }
}

export function loadLastState(){
  return safeParse(localStorage.getItem(K_LAST), null);
}
export function saveLastState(s){
  try { localStorage.setItem(K_LAST, JSON.stringify(s)); } catch {}
}

export function hasAckEpilepsy(){
  return localStorage.getItem(K_ACK) === '1';
}
export function ackEpilepsy(){
  try { localStorage.setItem(K_ACK, '1'); } catch {}
}
