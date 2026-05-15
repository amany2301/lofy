/* lofy — preset & settings storage (v1.3 — quota-aware)
   Every write returns a boolean so callers can surface a toast on
   QuotaExceededError instead of silently dropping the user's data. */

const K_SETTINGS = 'lofy_settings';
const K_PRESETS  = 'lofy_presets';
const K_LAST     = 'lofy_last_state';
const K_ACK      = 'lofy_epilepsy_ack';

export const DEFAULT_SETTINGS = {
  sensitivity: 5,
  reactivity: 7,
  strobeGuard: true,
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

// Returns true on success; false if localStorage is unavailable or full.
function safeSet(key, value){
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err){
    return false;
  }
}

export function loadSettings(){
  const s = safeParse(localStorage.getItem(K_SETTINGS), {});
  return { ...DEFAULT_SETTINGS, ...s };
}

export function saveSettings(s){
  return safeSet(K_SETTINGS, JSON.stringify(s));
}

export function loadPresets(){
  return safeParse(localStorage.getItem(K_PRESETS), []);
}

export function savePreset(preset){
  const arr = loadPresets();
  arr.push({ ...preset, id: 'u-' + Date.now(), createdAt: new Date().toISOString() });
  return safeSet(K_PRESETS, JSON.stringify(arr));
}

export function deletePreset(id){
  const arr = loadPresets().filter(p => p.id !== id);
  return safeSet(K_PRESETS, JSON.stringify(arr));
}

export function loadLastState(){
  return safeParse(localStorage.getItem(K_LAST), null);
}
export function saveLastState(s){
  return safeSet(K_LAST, JSON.stringify(s));
}

export function hasAckEpilepsy(){
  try { return localStorage.getItem(K_ACK) === '1'; } catch { return false; }
}
export function ackEpilepsy(){
  return safeSet(K_ACK, '1');
}
