/* lofy — control bar wiring, keyboard shortcuts, auto-hide, overlays */
import { BUILTIN_PALETTES } from './palettes.js';
import {
  loadSettings, saveSettings, loadPresets, savePreset, deletePreset,
} from './presets.js';
import { buildShareUrl, copyToClipboard } from './share.js';
import { RoomHost, RoomGuest, generateRoomCode } from './sync.js';

export class Controls {
  constructor({ audio, viz, onSourceChange, onError, onToast }){
    this.audio = audio;
    this.viz = viz;
    this.onSourceChange = onSourceChange;
    this.onError = onError;
    this.onToast = onToast;

    this.settings = loadSettings();
    this.activePaletteId = 'lofy-default';
    this.activeMode = 'spectrum';
    this.activeSource = 'mic';

    this._idleT = 0;
    this._idleHandler = this._onActivity.bind(this);
    this._onKey = this._onKey.bind(this);
    this._initialized = false;
    this._fileTickerId = 0;
    this._lastFocusedBeforeOverlay = null;
    this._userPalettes = {};      // pid -> preset (for event-delegated lookup)
    this._tapTimes = [];          // tap-tempo state
    this._tapTimer = 0;
  }

  init(){
    if (this._initialized) return;
    this._initialized = true;
    this._startLevelMeter();
    this._wireSourcePills();
    this._wireModePills();
    this._wireSensitivity();
    this._renderSwatches();
    this._wireIconButtons();
    this._wireOverlays();
    this._wireFileInput();
    this._wireBuilder();
    this._renderPresets();
    this._wireToggles();
    this._wireKeyboard();
    this._wireAutoHide();
    this._applySettingsToUI();
  }

  _applySettingsToUI(){
    document.getElementById('sens').value = this.settings.sensitivity;
    document.getElementById('sensVal').textContent = this.settings.sensitivity;
    document.getElementById('setSens').value = this.settings.sensitivity;
    document.getElementById('setSensVal').textContent = this.settings.sensitivity;
    this.audio.setSensitivity(this.settings.sensitivity);

    const r = this.settings.reactivity ?? 7;
    document.getElementById('react').value = r;
    document.getElementById('reactVal').textContent = r;
    document.getElementById('setReact').value = r;
    document.getElementById('setReactVal').textContent = r;
    this.viz.setReactivity(r);

    const hc = this.settings.hueCycleSec ?? 45;
    const hcEl = document.getElementById('setHueCycle');
    if (hcEl){
      hcEl.value = hc;
      document.getElementById('setHueCycleVal').textContent = hc + 's';
    }

    this._setToggle('tgStrobe', this.settings.strobeGuard);
    this._setToggle('tgBpm', this.settings.showBpm);
    this._setToggle('tgAuto', this.settings.autoHide);
    this._setToggle('tgKeys', this.settings.shortcuts);
    this._setToggle('tgHue', this.settings.hueRotate);
    this._setToggle('tgFps', this.settings.showFps);
    this._setIntensityPill(this.settings.colorIntensity);

    this.viz.setStrobeGuard(this.settings.strobeGuard);
    this.viz.setIntensity(this.settings.colorIntensity);

    document.querySelector('.bpm-badge').style.display = this.settings.showBpm ? '' : 'none';
  }

  _setToggle(id, on){
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('on', !!on);
    if (el.hasAttribute('role')) el.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  _setIntensityPill(level){
    document.querySelectorAll('[data-int]').forEach(b => {
      b.classList.toggle('active', b.dataset.int === level);
    });
  }

  _wireSourcePills(){
    // Disable Tab pill if browser lacks getDisplayMedia (Firefox/Safari mobile)
    if (!navigator.mediaDevices?.getDisplayMedia){
      const tabPill = document.querySelector('#srcGroup [data-src="tab"]');
      if (tabPill){
        tabPill.setAttribute('aria-disabled', 'true');
        tabPill.classList.add('disabled');
        tabPill.title = 'Tab capture not supported on this browser';
      }
    }
    document.getElementById('srcGroup').addEventListener('click', async (e) => {
      const btn = e.target.closest('.pill'); if (!btn) return;
      if (btn.getAttribute('aria-disabled') === 'true'){
        this.onToast && this.onToast(btn.title || 'Not supported on your browser', 'warn');
        return;
      }
      const src = btn.dataset.src;
      if (src === this.activeSource && src !== 'file' && src !== 'demo') return;
      try {
        if (src === 'mic'){
          await this.audio.useMic();
          this._setActivePill('srcGroup', 'src', 'mic');
          this.activeSource = 'mic';
          document.getElementById('trackbar').classList.remove('show');
          this.onSourceChange && this.onSourceChange('mic');
        } else if (src === 'file'){
          document.getElementById('dropzone').classList.add('show');
        } else if (src === 'tab'){
          await this.audio.useTab();
          this._setActivePill('srcGroup', 'src', 'tab');
          this.activeSource = 'tab';
          document.getElementById('trackbar').classList.remove('show');
          this.onSourceChange && this.onSourceChange('tab');
        } else if (src === 'demo'){
          // Delegated to app.js which knows how to fetch the cached demo buffer.
          if (typeof window.__lofy_playDemo === 'function'){
            await window.__lofy_playDemo();
            this._setActivePill('srcGroup', 'src', 'demo');
            this.activeSource = 'demo';
            this.onSourceChange && this.onSourceChange('demo');
          }
        }
      } catch (err){
        this.onError && this.onError(err.message || 'Failed to start audio source.');
      }
    });
  }

  _setActivePill(groupId, dataKey, value){
    document.getElementById(groupId).querySelectorAll('.pill').forEach(b => {
      const on = b.dataset[dataKey] === value;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  _wireModePills(){
    document.getElementById('modeGroup').addEventListener('click', (e) => {
      const btn = e.target.closest('.pill'); if (!btn) return;
      const m = btn.dataset.mode;
      this.setMode(m);
    });
  }

  setMode(m){
    this.activeMode = m;
    this._setActivePill('modeGroup', 'mode', m);
    this.viz.setMode(m);
  }

  // Brief canvas tint when the user changes a slider — instant feedback
  // without waiting for the next beat.
  _flashFeedback(){
    if (!this.viz || !this.viz.bumpFeedback) return;
    const color = (this.viz.palette && this.viz.palette[0]) || '#ffffff';
    this.viz.bumpFeedback(color, 0.16);
  }

  // Tiny level-meter loop that paints a horizontal bar inside #micLevel.
  // Updated by rAF; pulled from visualizer.totalEnergyEma.
  _startLevelMeter(){
    if (this._levelRaf) return;
    const bar = document.getElementById('micLevelBar');
    const wrap = document.getElementById('micLevel');
    const loop = () => {
      this._levelRaf = requestAnimationFrame(loop);
      if (!bar || !wrap) return;
      // Only show when source = mic
      const show = this.activeSource === 'mic';
      wrap.style.display = show ? 'flex' : 'none';
      if (!show) return;
      const v = Math.min(1, this.viz.totalEnergyEma || 0);
      bar.style.width = (v * 100).toFixed(1) + '%';
      bar.style.background = v < 0.05 ? 'var(--paper-faint)'
                            : v < 0.4 ? 'var(--cyan)'
                                       : 'var(--acid)';
    };
    this._levelRaf = requestAnimationFrame(loop);
  }

  _wireSensitivity(){
    const slider = document.getElementById('sens');
    const val = document.getElementById('sensVal');
    slider.addEventListener('input', () => {
      const v = +slider.value;
      val.textContent = v;
      this.audio.setSensitivity(v);
      this.settings.sensitivity = v;
      saveSettings(this.settings);
      document.getElementById('setSens').value = v;
      document.getElementById('setSensVal').textContent = v;
      this._flashFeedback();
    });
    const setSens = document.getElementById('setSens');
    setSens.addEventListener('input', () => {
      const v = +setSens.value;
      document.getElementById('setSensVal').textContent = v;
      document.getElementById('sens').value = v;
      document.getElementById('sensVal').textContent = v;
      this.audio.setSensitivity(v);
      this.settings.sensitivity = v;
      saveSettings(this.settings);
      this._flashFeedback();
    });

    // Reactivity (color responsiveness) — control-bar + settings-panel slider
    const applyReact = (v) => {
      document.getElementById('react').value = v;
      document.getElementById('reactVal').textContent = v;
      document.getElementById('setReact').value = v;
      document.getElementById('setReactVal').textContent = v;
      this.viz.setReactivity(v);
      this.settings.reactivity = v;
      saveSettings(this.settings);
      this._flashFeedback();
    };
    document.getElementById('react').addEventListener('input', e => applyReact(+e.target.value));
    document.getElementById('setReact').addEventListener('input', e => applyReact(+e.target.value));

    // Hue cycle length
    const setHueCycle = document.getElementById('setHueCycle');
    if (setHueCycle){
      setHueCycle.addEventListener('input', () => {
        const v = +setHueCycle.value;
        document.getElementById('setHueCycleVal').textContent = v + 's';
        this.settings.hueCycleSec = v;
        saveSettings(this.settings);
        this.viz.setHueCycleSec(v);
      });
    }
  }

  _renderSwatches(){
    const row = document.getElementById('swatchRow');
    row.innerHTML = '';
    this._userPalettes = {};
    BUILTIN_PALETTES.forEach(p => row.appendChild(this._swatchEl(p)));
    const userPresets = loadPresets();
    userPresets.forEach(p => {
      const preset = { id:p.id, name:p.name, mode:p.mode, colors:p.colors || p.palette };
      this._userPalettes[p.id] = preset;
      const el = this._swatchEl(preset);
      el.title = preset.name + ' (saved)';
      row.appendChild(el);
    });
    const add = document.createElement('button');
    add.className = 'swatch-add';
    add.title = 'Custom palette';
    add.setAttribute('aria-label', 'Open palette builder');
    add.dataset.swAdd = '1';
    add.innerHTML = '+';
    row.appendChild(add);
    this._highlightActiveSwatch();

    if (!row.dataset.delegated){
      row.dataset.delegated = '1';
      row.addEventListener('click', (e) => {
        const swatch = e.target.closest('.swatch');
        if (swatch){
          const pid = swatch.dataset.pid;
          const builtin = BUILTIN_PALETTES.find(p => p.id === pid);
          const user = this._userPalettes[pid];
          const palette = builtin || user;
          if (palette) this.setPalette(palette);
          return;
        }
        if (e.target.closest('[data-sw-add]')) this._openOverlay('presetsOverlay');
      });
    }
  }

  _swatchEl(p){
    const el = document.createElement('button');
    el.className = 'swatch';
    if (p.party) el.classList.add('party');
    el.dataset.pid = p.id;
    el.title = p.party
      ? `${p.name} — auto-strobes every color (DJ mode)`
      : p.name;
    el.setAttribute('aria-label', `Palette: ${p.name}`);
    // Party palettes show a tighter rainbow preview using more of the colors
    const N = p.party ? Math.min(p.colors.length, 6) : 4;
    const cols = p.colors.slice(0, N);
    while (cols.length < N) cols.push(cols[cols.length-1] || '#000');
    el.innerHTML = cols.map((c, i) => `<div class="s${i+1}" style="background:${c}"></div>`).join('');
    return el;
  }

  _highlightActiveSwatch(){
    document.querySelectorAll('.swatch').forEach(el => {
      el.classList.toggle('active', el.dataset.pid === this.activePaletteId);
    });
  }

  setPalette(p){
    this.activePaletteId = p.id;
    this.viz.setPalette(p);              // pass full preset so party flag flows
    this._highlightActiveSwatch();
    // Party palettes look best in Flash mode — auto-switch unless user already chose
    if (p.party && this.activeMode !== 'flash'){
      this.setMode('flash');
    }
  }

  _wireIconButtons(){
    document.getElementById('btnFs')?.addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btnSettings')?.addEventListener('click', () => this._openOverlay('settingsOverlay'));
    document.getElementById('btnPresets')?.addEventListener('click', () => this._openOverlay('presetsOverlay'));
    document.getElementById('btnHelp')?.addEventListener('click', () => this._openOverlay('helpOverlay'));
    document.getElementById('btnParty')?.addEventListener('click', () => this._openRoomSheet());
    document.getElementById('roomChipLeave')?.addEventListener('click', () => this._leaveRoom());
    document.getElementById('btnRec')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      if (btn?.getAttribute('aria-disabled') === 'true'){
        this.onToast && this.onToast(btn.title || 'Recording not supported on this browser', 'warn');
        return;
      }
      this._toggleRecording && this._toggleRecording();
    });

    // Tap-tempo via BPM badge (click) + double-click to clear
    const bpmBadge = document.getElementById('bpmBadge');
    if (bpmBadge){
      bpmBadge.addEventListener('click', () => this._tapTempo(performance.now()));
      bpmBadge.addEventListener('dblclick', () => this._clearManualBpm());
      bpmBadge.addEventListener('keydown', (e) => {
        if (e.key === ' ' || e.key === 'Enter'){ e.preventDefault(); this._tapTempo(performance.now()); }
      });
    }

    // Share preset URL
    document.getElementById('btnSharePreset')?.addEventListener('click', () => this._shareCurrent());
  }

  _tapTempo(nowMs){
    this._tapTimes.push(nowMs);
    // drop taps older than 3 seconds
    while (this._tapTimes.length && nowMs - this._tapTimes[0] > 3000) this._tapTimes.shift();
    const badge = document.getElementById('bpmBadge');
    const lbl = document.getElementById('bpmLbl');
    if (badge) badge.classList.add('tapping');
    if (lbl) lbl.innerHTML = `<em>TAP</em> · ${this._tapTimes.length}/4`;
    clearTimeout(this._tapTimer);
    this._tapTimer = setTimeout(() => this._finalizeTap(), 1500);
    if (this._tapTimes.length >= 4) this._finalizeTap();
  }

  _finalizeTap(){
    const badge = document.getElementById('bpmBadge');
    const lbl = document.getElementById('bpmLbl');
    if (this._tapTimes.length < 2){
      if (badge) badge.classList.remove('tapping');
      if (lbl) lbl.textContent = 'BPM · LIVE';
      this._tapTimes.length = 0;
      return;
    }
    const intervals = [];
    for (let i = 1; i < this._tapTimes.length; i++) intervals.push(this._tapTimes[i] - this._tapTimes[i-1]);
    intervals.sort((a,b) => a - b);
    const med = intervals[Math.floor(intervals.length/2)];
    const bpm = Math.round(60000 / med);
    if (bpm >= 40 && bpm <= 220){
      this.viz.setManualBpm(bpm);
      document.getElementById('bpmVal').textContent = bpm;
      if (badge){
        badge.classList.remove('tapping');
        badge.classList.add('manual');
        badge.style.setProperty('--bpm-beat-ms', (60000 / bpm) + 'ms');
      }
      if (lbl) lbl.innerHTML = `<em>MANUAL</em> · ${bpm}`;
      this.onToast && this.onToast(`Tempo locked at ${bpm} BPM · use ← → to fine-tune`, 'ok');
    } else {
      if (badge) badge.classList.remove('tapping');
      if (lbl) lbl.textContent = 'BPM · LIVE';
      this.onToast && this.onToast('Out of range — try tapping evenly', 'warn');
    }
    this._tapTimes.length = 0;
  }

  _clearManualBpm(){
    this.viz.setManualBpm(0);
    const badge = document.getElementById('bpmBadge');
    const lbl = document.getElementById('bpmLbl');
    badge?.classList.remove('manual','tapping');
    badge?.style.removeProperty('--bpm-beat-ms');
    if (lbl) lbl.textContent = 'BPM · LIVE';
    this.onToast && this.onToast('Auto BPM restored', 'ok');
  }

  _shareCurrent(){
    const url = buildShareUrl({
      mode: this.activeMode,
      palette: this.viz.palette,
      sens: this.settings.sensitivity,
      react: this.settings.reactivity,
    });
    copyToClipboard(url).then((ok) => {
      this.onToast && this.onToast(ok ? 'Link copied · share this look' : 'Copy failed — selecting text', ok ? 'ok' : 'warn');
    });
  }

  toggleFullscreen(){
    if (!document.fullscreenElement){
      (document.documentElement.requestFullscreen || (()=>{})).call(document.documentElement);
    } else {
      (document.exitFullscreen || (()=>{})).call(document);
    }
  }

  _wireOverlays(){
    document.querySelectorAll('[data-close]').forEach(b => {
      b.addEventListener('click', () => this._closeOverlays());
    });
    document.querySelectorAll('.overlay').forEach(o => {
      o.addEventListener('click', (e) => {
        if (e.target === o) this._closeOverlays();
      });
      // simple focus trap within the sheet while open
      o.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab' || !o.classList.contains('show')) return;
        const focusable = o.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
      });
    });
  }

  _openOverlay(id){
    const o = document.getElementById(id);
    if (!o) return;
    this._lastFocusedBeforeOverlay = document.activeElement;
    o.classList.add('show');
    if (id === 'presetsOverlay') this._renderPresets();
    // focus close button so Esc / Tab is intuitive
    queueMicrotask(() => {
      const close = o.querySelector('[data-close]');
      if (close) close.focus();
    });
  }
  _closeOverlays(){
    document.querySelectorAll('.overlay').forEach(o => o.classList.remove('show'));
    if (this._lastFocusedBeforeOverlay){
      try { this._lastFocusedBeforeOverlay.focus(); } catch {}
      this._lastFocusedBeforeOverlay = null;
    }
  }

  _wireFileInput(){
    const drop = document.getElementById('dropzone');
    const input = document.getElementById('fileInput');
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (f) await this._loadFile(f);
    });
    drop.addEventListener('dragenter', e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', e => { e.preventDefault(); drop.classList.remove('over'); });
    drop.addEventListener('drop', async e => {
      e.preventDefault(); drop.classList.remove('over');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) await this._loadFile(f);
    });
    // play/pause + scrub
    const btnPlay = document.getElementById('btnPlay');
    const scrub = document.getElementById('scrub');
    btnPlay.addEventListener('click', () => {
      this.audio.filePlayPause();
    });
    let scrubbing = false;
    scrub.addEventListener('input', () => { scrubbing = true; });
    scrub.addEventListener('change', () => {
      const dur = this.audio.fileDuration();
      this.audio.fileSeek((+scrub.value / 1000) * dur);
      scrubbing = false;
    });
    // ticker — singleton; guarded against re-init
    if (this._fileTickerId) clearInterval(this._fileTickerId);
    this._fileTickerId = setInterval(() => {
      if (this.audio.sourceType !== 'file') return;
      const dur = this.audio.fileDuration();
      const cur = this.audio.fileCurrentTime();
      if (!scrubbing) scrub.value = dur ? Math.round(cur / dur * 1000) : 0;
      document.getElementById('curTime').textContent = fmtTime(cur);
      document.getElementById('durTime').textContent = fmtTime(dur);
    }, 250);
  }

  async _loadFile(f){
    try {
      await this.audio.useFile(f);
      document.getElementById('dropzone').classList.remove('show');
      document.getElementById('trackbar').classList.add('show');
      document.getElementById('trackName').textContent = f.name;
      this._setActivePill('srcGroup', 'src', 'file');
      this.activeSource = 'file';
      this.onSourceChange && this.onSourceChange('file');
    } catch (err){
      this.onError && this.onError(err.message);
    }
  }

  _wireBuilder(){
    const inputs = document.querySelectorAll('#builder input[type=color]');
    const getColors = () => Array.from(inputs).map(i => i.value);
    document.getElementById('btnApplyBuilder').addEventListener('click', () => {
      const colors = getColors();
      this.setPalette({ id:'custom-live', name:'Custom', colors });
    });
    document.getElementById('btnSaveBuilder').addEventListener('click', () => {
      const name = prompt('Name this preset:');
      if (!name) return;
      const ok = savePreset({ name, mode: this.activeMode, palette: getColors(), colors: getColors() });
      if (ok){
        this.onToast && this.onToast('Preset saved · ' + name, 'ok');
        this._renderSwatches();
        this._renderPresets();
      } else {
        this.onToast && this.onToast('Storage full — delete a preset first.', 'warn');
      }
    });
  }

  _renderPresets(){
    const builtin = document.getElementById('builtinGrid');
    const user = document.getElementById('userGrid');
    builtin.innerHTML = '';
    user.innerHTML = '';

    BUILTIN_PALETTES.forEach(p => builtin.appendChild(this._presetCard(p, false)));

    const ups = loadPresets();
    if (!ups.length){
      user.innerHTML = '<div style="font-size:12px;color:var(--paper-faint);padding:8px 0">No saved presets yet. Build one above and tap "Save preset".</div>';
    } else {
      ups.forEach(p => user.appendChild(this._presetCard(
        { id:p.id, name:p.name, mode:p.mode, colors:p.colors || p.palette },
        true,
      )));
    }
  }

  _presetCard(p, deletable){
    const c = document.createElement('div');
    c.className = 'preset-card';
    const cols = (p.colors || []).slice(0,4);
    while (cols.length < 4) cols.push(cols[cols.length-1] || '#000');
    c.innerHTML = `
      <div class="row"><span class="meta">${p.mode || ''}</span>${deletable ? `<button class="del" data-del="${p.id}" title="Delete">✕</button>` : ''}</div>
      <div class="pal">
        <div style="background:${cols[0]}"></div>
        <div style="background:${cols[1]}"></div>
        <div style="background:${cols[2]}"></div>
        <div style="background:${cols[3]}"></div>
      </div>
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="row"><span class="meta">Load →</span></div>
    `;
    c.addEventListener('click', (e) => {
      if (e.target.dataset.del){
        e.stopPropagation();
        deletePreset(e.target.dataset.del);
        this._renderPresets();
        this._renderSwatches();
        return;
      }
      this.setPalette(p);
      if (p.mode) this.setMode(p.mode);
    });
    return c;
  }

  _wireToggles(){
    document.querySelectorAll('.toggle').forEach(t => {
      t.addEventListener('click', () => {
        const key = t.dataset.key;
        if (!key) return;
        const newVal = !t.classList.contains('on');
        t.classList.toggle('on', newVal);
        if (t.hasAttribute('role')) t.setAttribute('aria-checked', newVal ? 'true' : 'false');
        t.classList.remove('pop'); void t.offsetWidth; t.classList.add('pop');
        this.settings[key] = newVal;
        const ok = saveSettings(this.settings);
        if (!ok) this.onToast && this.onToast('Storage full — settings may not persist', 'warn');
        if (key === 'strobeGuard') this.viz.setStrobeGuard(newVal);
        if (key === 'showBpm') document.querySelector('.bpm-badge').style.display = newVal ? '' : 'none';
        if (key === 'autoHide' && !newVal) this._showChrome();
        if (key === 'hueRotate') this.viz.setHueRotate(newVal, this.settings.hueCycleSec);
        if (key === 'showFps') document.getElementById('fpsChip')?.classList.toggle('show', newVal);
      });
    });
    document.querySelectorAll('[data-int]').forEach(b => {
      b.addEventListener('click', () => {
        const v = b.dataset.int;
        this._setIntensityPill(v);
        this.settings.colorIntensity = v;
        saveSettings(this.settings);
        this.viz.setIntensity(v);
      });
    });
  }

  _wireKeyboard(){
    document.addEventListener('keydown', this._onKey);
  }
  _onKey(e){
    if (!this.settings.shortcuts) return;
    if (e.target.matches('input, textarea, [contenteditable]')) return;
    const key = e.key;
    if (key === 'f' || key === 'F'){ this.toggleFullscreen(); }
    else if (key === '1'){ this.setMode('spectrum'); }
    else if (key === '2'){ this.setMode('flash'); }
    else if (key === '3'){ this.setMode('particles'); }
    else if (key === '4'){ this.setMode('waveform'); }
    else if (key === 'm' || key === 'M'){
      // cycle source
      const order = ['mic','file','tab','demo'];
      const next = order[(order.indexOf(this.activeSource) + 1) % order.length];
      document.querySelector(`[data-src="${next}"]`)?.click();
    }
    else if (key === 'ArrowRight'){
      // When BPM is locked to manual, arrows nudge tempo by ±1; otherwise sens.
      if (this.viz?.detector?.manualBpm){
        const nb = Math.min(220, this.viz.detector.manualBpm + 1);
        this.viz.setManualBpm(nb);
        document.getElementById('bpmVal').textContent = nb;
        const lbl = document.getElementById('bpmLbl');
        if (lbl) lbl.innerHTML = `<em>MANUAL</em> · ${nb}`;
        const badge = document.getElementById('bpmBadge');
        if (badge) badge.style.setProperty('--bpm-beat-ms', (60000 / nb) + 'ms');
      } else {
        const s = Math.min(10, this.settings.sensitivity + 1);
        this.settings.sensitivity = s; saveSettings(this.settings);
        this.audio.setSensitivity(s);
        document.getElementById('sens').value = s;
        document.getElementById('sensVal').textContent = s;
        this._flashFeedback();
      }
    }
    else if (key === 'ArrowLeft'){
      if (this.viz?.detector?.manualBpm){
        const nb = Math.max(40, this.viz.detector.manualBpm - 1);
        this.viz.setManualBpm(nb);
        document.getElementById('bpmVal').textContent = nb;
        const lbl = document.getElementById('bpmLbl');
        if (lbl) lbl.innerHTML = `<em>MANUAL</em> · ${nb}`;
        const badge = document.getElementById('bpmBadge');
        if (badge) badge.style.setProperty('--bpm-beat-ms', (60000 / nb) + 'ms');
      } else {
        const s = Math.max(1, this.settings.sensitivity - 1);
        this.settings.sensitivity = s; saveSettings(this.settings);
        this.audio.setSensitivity(s);
        document.getElementById('sens').value = s;
        document.getElementById('sensVal').textContent = s;
        this._flashFeedback();
      }
    }
    else if (key === 'p' || key === 'P'){ this._openOverlay('presetsOverlay'); }
    else if (key === '?'){ e.preventDefault(); this._openOverlay('helpOverlay'); }
    else if (key === 't' || key === 'T'){ this._tapTempo(performance.now()); }
    else if (key === 'r' || key === 'R'){ this._toggleRecording && this._toggleRecording(); }
    else if (key === 's' || key === 'S'){ this._shareCurrent && this._shareCurrent(); }
    else if (key === 'Escape'){
      this._closeOverlays();
      document.getElementById('dropzone').classList.remove('show');
    }
    else if (key === ' '){
      if (this.audio.sourceType === 'file'){
        e.preventDefault();
        this.audio.filePlayPause();
      }
    }
  }

  _wireAutoHide(){
    ['mousemove','touchstart','keydown'].forEach(ev =>
      document.addEventListener(ev, this._idleHandler, { passive:true }));
    setInterval(() => {
      if (!this.settings.autoHide) return;
      if (document.fullscreenElement && Date.now() - this._lastActivity > 3000){
        document.body.classList.add('idle');
      }
    }, 800);
  }
  _onActivity(){
    this._lastActivity = Date.now();
    this._showChrome();
  }
  _showChrome(){
    document.body.classList.remove('idle');
  }

  // ─────────────────────── PARTY ROOMS (v2.0) ───────────────────────

  _openRoomSheet(){
    // If already in a room, jump straight to the connected view
    if (this._currentRoom){
      this._roomShowView('connected');
      this._updateRoomConnectedView();
    } else {
      this._roomShowView('root');
    }
    this._wireRoomFlows();
    this._openOverlay('roomOverlay');
  }

  _roomShowView(name){
    document.querySelectorAll('#roomOverlay .room-view').forEach((v) => {
      v.hidden = v.dataset.view !== name;
    });
  }

  _wireRoomFlows(){
    if (this._roomFlowsWired) return;
    this._roomFlowsWired = true;

    // Root view
    document.getElementById('roomStartBtn')?.addEventListener('click', () => this._roomShowView('host-pick'));
    document.getElementById('roomJoinBtn') ?.addEventListener('click', () => this._roomShowView('guest-pick'));

    // Host picks signaling path
    document.getElementById('hostQrBtn')   ?.addEventListener('click', () => this._hostStartQr());
    document.getElementById('hostCodeBtn') ?.addEventListener('click', () => this._hostStartCode());

    // Host QR scan-answer button
    document.getElementById('hostQrScanBtn')?.addEventListener('click', () => this._hostScanAnswer());

    // Host code copy + share
    document.getElementById('hostCodeCopyBtn')?.addEventListener('click', () => this._hostCopyCode());
    document.getElementById('hostCodeShareBtn')?.addEventListener('click', () => this._hostShareCode());

    // Guest picks signaling path
    document.getElementById('guestScanBtn')?.addEventListener('click', () => this._guestStartScan());
    document.getElementById('guestCodeBtn')?.addEventListener('click', () => this._roomShowView('guest-code'));
    document.getElementById('guestCodeJoinBtn')?.addEventListener('click', () => this._guestJoinCode());
    document.getElementById('guestCodeInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._guestJoinCode();
    });

    // Connected view leave button
    document.getElementById('roomLeaveBtn')?.addEventListener('click', () => this._leaveRoom());

    // Back buttons inside any room-view
    document.querySelectorAll('#roomOverlay [data-room-back]').forEach((btn) => {
      btn.addEventListener('click', () => this._roomBack());
    });

    // Show Web Share API button on supported devices
    if (navigator.share){
      const shareBtn = document.getElementById('hostCodeShareBtn');
      if (shareBtn) shareBtn.hidden = false;
    }
  }

  _roomBack(){
    // Cancel any in-flight scan / waiting
    if (this._scanStopFn){ try { this._scanStopFn(); } catch {} this._scanStopFn = null; }
    // If a tentative host/guest was created but not connected, clean it up
    if (this._tentativeRoom){
      try { this._tentativeRoom.close ? this._tentativeRoom.close() : this._tentativeRoom.leave(); } catch {}
      this._tentativeRoom = null;
    }
    this._roomShowView('root');
  }

  // ─── HOST · QR path ───────────────────────────────────────────────

  async _hostStartQr(){
    try {
      const { loadQrLibs, encodeSdpForQr, renderQrToCanvas } =
        await import('./qr-signal.js');
      await loadQrLibs();

      const host = new RoomHost();
      this._tentativeRoom = host;
      this._wireHostEvents(host);

      const { guestId, offerSdp } = await host.createOffer();
      this._pendingHostGuestId = guestId;
      const encoded = await encodeSdpForQr(offerSdp);

      const canvas = document.getElementById('hostQrCanvas');
      renderQrToCanvas(encoded, canvas, 320);
      document.getElementById('hostQrStep').textContent =
        '1 · Have your friend scan this with the lofy app';
      this._roomShowView('host-qr');
    } catch (err){
      this.onToast && this.onToast('Could not start QR mode: ' + (err.message || err), 'warn');
    }
  }

  async _hostScanAnswer(){
    try {
      const { startCameraScan, decodeSdpFromQr } = await import('./qr-signal.js');
      this._roomShowView('host-qr');
      document.getElementById('hostQrStep').textContent = '2 · Scan your friend\'s response';
      // Replace the offer-QR canvas with a temporary scan view
      // by stealing the qr-stage and inserting a video — done via swap
      this._switchHostStageToScan();

      const video = this._hostScanVideo;
      this._scanStopFn = await startCameraScan({
        videoEl: video,
        onResult: async (text) => {
          this._scanStopFn = null;
          try {
            const answerSdp = await decodeSdpFromQr(text);
            await this._tentativeRoom.acceptAnswer(this._pendingHostGuestId, answerSdp);
            this._restoreHostStage();
            this._activateHostRoom(this._tentativeRoom);
          } catch (err){
            this.onToast && this.onToast('Bad QR — ' + (err.message || err), 'warn');
            this._restoreHostStage();
            this._roomShowView('host-qr');
          }
        },
        onError: (err) => {
          this.onToast && this.onToast('Camera: ' + (err.message || err), 'warn');
          this._restoreHostStage();
          this._roomShowView('host-pick');
        },
      });
    } catch (err){
      this.onToast && this.onToast('Scanner failed: ' + (err.message || err), 'warn');
    }
  }

  _switchHostStageToScan(){
    const stage = document.querySelector('#roomOverlay [data-view="host-qr"] .qr-stage');
    if (!stage) return;
    this._hostStageOriginal = stage.innerHTML;
    stage.innerHTML = '<video id="hostScanVideo" playsinline muted></video><div class="qr-viewfinder" aria-hidden="true"></div>';
    this._hostScanVideo = document.getElementById('hostScanVideo');
  }
  _restoreHostStage(){
    if (this._hostStageOriginal == null) return;
    const stage = document.querySelector('#roomOverlay [data-view="host-qr"] .qr-stage');
    if (stage) stage.innerHTML = this._hostStageOriginal;
    this._hostStageOriginal = null;
    this._hostScanVideo = null;
  }

  // ─── HOST · Code path ─────────────────────────────────────────────

  async _hostStartCode(){
    try {
      const { attachHostToBroker } = await import('./peer-signal.js');
      const code = generateRoomCode();
      const host = new RoomHost({ code });
      this._tentativeRoom = host;
      this._wireHostEvents(host);

      document.getElementById('hostCodeBig').textContent = code;
      document.getElementById('hostCodeStatus').textContent = 'Connecting to broker…';
      this._roomShowView('host-code');

      await attachHostToBroker(host, code);
      document.getElementById('hostCodeStatus').textContent = 'Waiting for guests…';
      // Once the first guest joins, the guestjoin event handler activates the room
    } catch (err){
      const el = document.getElementById('hostCodeStatus');
      if (el){ el.textContent = err.message || String(err); el.classList.add('error'); }
      this._tentativeRoom = null;
    }
  }

  _hostCopyCode(){
    const code = document.getElementById('hostCodeBig')?.textContent || '';
    copyToClipboard(`Join my lofy Party Room — code: ${code} → lofy.vizleo.com`).then((ok) => {
      this.onToast && this.onToast(ok ? 'Code copied with link' : 'Copy failed', ok ? 'ok' : 'warn');
    });
  }
  _hostShareCode(){
    if (!navigator.share) return;
    const code = document.getElementById('hostCodeBig')?.textContent || '';
    navigator.share({
      title: 'lofy Party Room',
      text: `Join my lofy Party Room — code ${code}`,
      url: 'https://lofy.vizleo.com/app.html',
    }).catch(() => {});
  }

  // ─── GUEST · QR path ──────────────────────────────────────────────

  async _guestStartScan(){
    try {
      const { loadQrLibs, startCameraScan, decodeSdpFromQr, encodeSdpForQr, renderQrToCanvas } =
        await import('./qr-signal.js');
      await loadQrLibs();

      this._roomShowView('guest-qr');
      document.getElementById('guestScanStatus').textContent = 'Looking for QR…';

      const video = document.getElementById('guestScanVideo');
      this._scanStopFn = await startCameraScan({
        videoEl: video,
        onResult: async (text) => {
          this._scanStopFn = null;
          try {
            const offerSdp = await decodeSdpFromQr(text);
            const guest = new RoomGuest();
            this._tentativeRoom = guest;
            this._wireGuestEvents(guest);
            const answerSdp = await guest.acceptOffer(offerSdp);
            const encodedAnswer = await encodeSdpForQr(answerSdp);
            renderQrToCanvas(encodedAnswer, document.getElementById('guestAnswerCanvas'), 320);
            this._roomShowView('guest-answer');
            // Wait for host to scan our answer — connection will fire 'connect'
          } catch (err){
            this.onToast && this.onToast('Couldn\'t parse QR: ' + (err.message || err), 'warn');
            this._roomShowView('guest-pick');
          }
        },
        onError: (err) => {
          const el = document.getElementById('guestScanStatus');
          if (el){ el.textContent = err.message || String(err); el.classList.add('error'); }
        },
      });
    } catch (err){
      this.onToast && this.onToast('Scanner failed: ' + (err.message || err), 'warn');
    }
  }

  // ─── GUEST · Code path ────────────────────────────────────────────

  async _guestJoinCode(){
    const input = document.getElementById('guestCodeInput');
    const status = document.getElementById('guestCodeStatus');
    const raw = (input?.value || '').toUpperCase().trim();
    if (raw.length !== 4){
      if (status){ status.textContent = 'Enter the 4-letter code'; status.classList.add('error'); }
      return;
    }
    try {
      const { joinViaBroker } = await import('./peer-signal.js');
      if (status){ status.textContent = 'Connecting…'; status.classList.remove('error'); }
      const guest = new RoomGuest();
      this._tentativeRoom = guest;
      this._wireGuestEvents(guest);
      await joinViaBroker(guest, raw);
      // Connection fires 'connect' event → activates the room
    } catch (err){
      if (status){ status.textContent = err.message || String(err); status.classList.add('error'); }
      this._tentativeRoom = null;
    }
  }

  // ─── Event wiring for host / guest ───────────────────────────────

  _wireHostEvents(host){
    host.on('guestjoin', () => {
      // First join activates the room (moves out of tentative state)
      if (this._tentativeRoom === host && !this._currentRoom){
        this._activateHostRoom(host);
      } else {
        this._updateRoomChip();
        this.onToast && this.onToast('Guest joined · ' + host.guestCount + ' total', 'ok');
      }
    });
    host.on('guestleave', () => {
      this._updateRoomChip();
    });
    host.on('close', () => {
      this._teardownRoom();
    });
  }

  _wireGuestEvents(guest){
    guest.on('connect', () => {
      if (this._tentativeRoom === guest && !this._currentRoom){
        this._activateGuestRoom(guest);
      }
    });
    guest.on('state', (msg) => {
      const { type, t, ...rest } = msg;
      this.viz.followState(rest);
    });
    guest.on('beat', (msg) => {
      this.viz.followBeat(msg);
    });
    guest.on('disconnect', (e) => {
      this.onToast && this.onToast('Disconnected · ' + (e?.reason || 'unknown'), 'warn');
      this._teardownRoom();
    });
  }

  _activateHostRoom(host){
    this._currentRoom = host;
    this._roomKind = 'host';
    this._tentativeRoom = null;

    // Hijack viz.onBeat → also broadcast to guests
    const origOnBeat = this.viz.onBeat;
    this._origOnBeat = origOnBeat;
    this.viz.onBeat = (bpm) => {
      if (origOnBeat) try { origOnBeat(bpm); } catch {}
      host.broadcastBeat({
        bpm,
        energy: this.viz.lastTotalEnergy || 0,
        lowEnergy: this.viz._lastBeatEnergy || 0,
      });
    };

    // Hijack setMode + setPalette + setReactivity to also broadcast
    this._origSetMode = this.setMode.bind(this);
    this._origSetPal  = this.setPalette.bind(this);
    this.setMode = (m) => {
      this._origSetMode(m);
      host.broadcastState({ mode: m });
    };
    this.setPalette = (p) => {
      this._origSetPal(p);
      host.broadcastState({ mode: this.activeMode, palette: this.viz.palette });
    };

    // Send current state immediately for late joiners
    host.broadcastState({
      mode: this.activeMode,
      palette: this.viz.palette,
      react: this.settings.reactivity,
    });

    this._updateRoomChip();
    this._roomShowView('connected');
    this._updateRoomConnectedView();
    this.onToast && this.onToast('Room ' + host.code + ' live', 'ok');
  }

  _activateGuestRoom(guest){
    this._currentRoom = guest;
    this._roomKind = 'guest';
    this._tentativeRoom = null;

    // Switch visualizer into follower mode
    this.viz.setFollowerMode(true);

    // Disable mode + source pills since the host drives them
    document.querySelectorAll('#srcGroup .pill').forEach((p) => p.classList.add('disabled'));

    this._updateRoomChip();
    this._roomShowView('connected');
    this._updateRoomConnectedView();
    this.onToast && this.onToast('Joined room · following host', 'ok');
  }

  _updateRoomChip(){
    const chip = document.getElementById('roomChip');
    const codeEl = document.getElementById('roomChipCode');
    const countEl = document.getElementById('roomChipCount');
    if (!chip || !this._currentRoom){
      if (chip) chip.hidden = true;
      return;
    }
    chip.hidden = false;
    if (this._roomKind === 'host'){
      codeEl.textContent = this._currentRoom.code;
      countEl.textContent = String(this._currentRoom.guestCount);
      countEl.hidden = false;
    } else {
      codeEl.textContent = 'FOLLOWING';
      countEl.hidden = true;
    }
  }

  _updateRoomConnectedView(){
    if (!this._currentRoom) return;
    const titleEl = document.getElementById('connectedTitle');
    const detailEl = document.getElementById('connectedDetail');
    if (this._roomKind === 'host'){
      titleEl.textContent = 'Live · Room ' + this._currentRoom.code;
      detailEl.textContent = this._currentRoom.guestCount + ' guest' +
        (this._currentRoom.guestCount === 1 ? '' : 's') + ' · audio stays on this device';
    } else {
      titleEl.textContent = 'Following the host';
      detailEl.textContent = 'Visuals are driven by the room host · no local audio';
    }
  }

  _leaveRoom(){
    if (!this._currentRoom) {
      this._teardownRoom();
      return;
    }
    try {
      if (this._roomKind === 'host') this._currentRoom.close();
      else this._currentRoom.leave();
    } catch {}
    this._teardownRoom();
  }

  _teardownRoom(){
    // Restore overridden viz callbacks / set methods
    if (this._origOnBeat !== undefined){
      this.viz.onBeat = this._origOnBeat;
      this._origOnBeat = undefined;
    }
    if (this._origSetMode){ this.setMode = this._origSetMode; this._origSetMode = null; }
    if (this._origSetPal) { this.setPalette = this._origSetPal;  this._origSetPal  = null; }

    if (this._roomKind === 'guest'){
      this.viz.setFollowerMode(false);
      document.querySelectorAll('#srcGroup .pill').forEach((p) => p.classList.remove('disabled'));
    }

    this._currentRoom = null;
    this._roomKind = null;
    this._tentativeRoom = null;
    this._pendingHostGuestId = null;
    if (this._scanStopFn){ try { this._scanStopFn(); } catch {} this._scanStopFn = null; }

    const chip = document.getElementById('roomChip');
    if (chip) chip.hidden = true;
    this._restoreHostStage && this._restoreHostStage();

    // If overlay still open, return to root
    if (document.getElementById('roomOverlay')?.classList.contains('show')){
      this._roomShowView('root');
    }
  }
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTime(s){
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), x = Math.floor(s % 60);
  return m + ':' + String(x).padStart(2, '0');
}
