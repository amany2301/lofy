/* lofy — demo audio generator
   Builds a short, loopable 128-BPM track in memory using OfflineAudioContext.
   Pattern: 4-on-the-floor kick + offbeat hat + simple bass line, 4 bars total.
   Returns a regular AudioBuffer that any AudioContext can consume. */

const BPM = 128;
const BARS = 8;                  // longer loop — ~15 s — more variety on repeat
const BEATS_PER_BAR = 4;
const SAMPLE_RATE = 44100;

function secondsPerBeat(){ return 60 / BPM; }
function totalDuration(){ return secondsPerBeat() * BEATS_PER_BAR * BARS; }

// ---- voice generators ----
function scheduleKick(ctx, dest, t){
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(140, t);
  osc.frequency.exponentialRampToValueAtTime(45, t + 0.15);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(1.1, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.42);
  osc.connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + 0.5);
}

function scheduleHat(ctx, dest, t, accent = false){
  // Noise burst → high-pass for hi-hat
  const buf = ctx.createBuffer(1, SAMPLE_RATE * 0.07, SAMPLE_RATE);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 7000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(accent ? 0.55 : 0.32, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
  src.connect(hp).connect(gain).connect(dest);
  src.start(t);
}

function scheduleSnare(ctx, dest, t){
  const buf = ctx.createBuffer(1, SAMPLE_RATE * 0.18, SAMPLE_RATE);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.7;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.exponentialRampToValueAtTime(0.7, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
  src.connect(bp).connect(gain).connect(dest);
  src.start(t);
}

function scheduleBass(ctx, dest, t, midi){
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, t);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 600; lp.Q.value = 4;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(0.42, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + secondsPerBeat() * 0.85);
  osc.connect(lp).connect(gain).connect(dest);
  osc.start(t);
  osc.stop(t + secondsPerBeat() + 0.1);
}

let cachedBuffer = null;

export async function getDemoBuffer(){
  if (cachedBuffer) return cachedBuffer;
  const dur = totalDuration();
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineCtx) throw new Error('OfflineAudioContext not supported in this browser');
  const ctx = new OfflineCtx(2, Math.ceil(SAMPLE_RATE * dur), SAMPLE_RATE);

  const master = ctx.createGain();
  master.gain.value = 0.85;
  // gentle compression so peaks don't clip on loop boundary
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -10;
  comp.knee.value = 8;
  comp.ratio.value = 5;
  comp.attack.value = 0.01;
  comp.release.value = 0.2;
  master.connect(comp).connect(ctx.destination);

  const spb = secondsPerBeat();
  // Four-bar walking root pattern — rotates twice across the 8-bar loop.
  const bassWalk = [33, 33, 36, 33, 31, 31, 36, 38];   // A, A, C, A, G, G, C, D
  for (let bar = 0; bar < BARS; bar++){
    const bar0 = bar * BEATS_PER_BAR * spb;
    const dropOut = (bar === 5);     // bar 6 (zero-indexed 5): build, no kick
    // Kick on every beat (4 on the floor) — except the build-up bar
    if (!dropOut){
      for (let beat = 0; beat < BEATS_PER_BAR; beat++){
        scheduleKick(ctx, master, bar0 + beat * spb);
      }
    }
    // Hats on offbeats. Bars 2 and 6 get 16th-note accents for energy.
    for (let beat = 0; beat < BEATS_PER_BAR; beat++){
      scheduleHat(ctx, master, bar0 + beat * spb + spb * 0.5);
      if (bar === 2 || bar === 5){
        scheduleHat(ctx, master, bar0 + beat * spb + spb * 0.25, false);
        scheduleHat(ctx, master, bar0 + beat * spb + spb * 0.75, true);
      }
    }
    // Snare on beats 2 and 4
    scheduleSnare(ctx, master, bar0 + 1 * spb);
    scheduleSnare(ctx, master, bar0 + 3 * spb);
    // Bass on every beat, walking through the 8-note pattern
    for (let beat = 0; beat < BEATS_PER_BAR; beat++){
      const noteIx = (bar * BEATS_PER_BAR + beat) % bassWalk.length;
      scheduleBass(ctx, master, bar0 + beat * spb, bassWalk[noteIx]);
    }
  }

  cachedBuffer = await ctx.startRendering();
  return cachedBuffer;
}
