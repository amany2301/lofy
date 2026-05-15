/* lofy — Party Rooms WebRTC sync (Day 1)
   ────────────────────────────────────────────────────────────
   The host's browser tab IS the room server. Guests connect via
   RTCPeerConnection data channels. No backend.

   Two signaling paths converge here. They use OPPOSITE offerer roles
   so the API exposes both directions explicitly:

     QR path     →  Host is OFFERER  (host.createOffer / guest.acceptOffer / host.acceptAnswer)
                    Host shows offer QR, guest scans + responds with answer QR.

     PeerJS path →  Guest is OFFERER (guest.createOffer / host.acceptOffer / guest.acceptAnswer)
                    Guest dials the room code; host listens on the broker.

   Once a data channel opens, the message protocol is identical
   regardless of which path created it.

   Message envelope (JSON on every send):  { type, ...payload, t }
       t = sender's performance.now() in ms

   Types:
     hello   guest → host       guest joined
     state   host  → guest      mode / palette / sens / react change
     beat    host  → guest      beat detected
     ping    host  → guest      clock-sync request
     pong    guest → host       clock-sync response
     bye     either side        graceful leave
*/

// ─────────────────────────── Config ───────────────────────────

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const DATA_CHANNEL_OPTS = {
  ordered: false,        // unordered = lower latency
  maxRetransmits: 0,     // unreliable = no head-of-line blocking on drops
};

const PING_INTERVAL_MS  = 5000;
const CONNECT_TIMEOUT_MS = 8000;
const GUEST_STALE_MS    = 15000;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';  // skip I/O/0/1

export function generateRoomCode(len = 4){
  let s = '';
  for (let i = 0; i < len; i++){
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

// ─────────────────────────── Helpers ───────────────────────────

function waitForIceGatheringComplete(pc, timeoutMs = 4000){
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const onChange = () => {
      if (pc.iceGatheringState === 'complete'){
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
    // Fail-open: some browsers stall in 'gathering' indefinitely
    setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }, timeoutMs);
  });
}

function waitForChannelOpen(channel, timeoutMs = CONNECT_TIMEOUT_MS){
  return new Promise((resolve) => {
    if (channel.readyState === 'open') return resolve(true);
    const onOpen = () => { cleanup(); resolve(true); };
    const onClose = () => { cleanup(); resolve(false); };
    const cleanup = () => {
      channel.removeEventListener('open', onOpen);
      channel.removeEventListener('close', onClose);
      channel.removeEventListener('error', onClose);
    };
    channel.addEventListener('open', onOpen);
    channel.addEventListener('close', onClose);
    channel.addEventListener('error', onClose);
    setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
  });
}

function jsonSend(channel, obj){
  if (channel?.readyState !== 'open') return false;
  try { channel.send(JSON.stringify(obj)); return true; }
  catch { return false; }
}

function emitter(){
  const listeners = new Map();
  return {
    on(evt, fn){
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
    },
    off(evt, fn){ listeners.get(evt)?.delete(fn); },
    emit(evt, ...args){
      const set = listeners.get(evt);
      if (set) for (const fn of set){ try { fn(...args); } catch {} }
    },
  };
}

// ─────────────────────────── RoomHost ───────────────────────────

export class RoomHost {
  constructor(opts = {}){
    this.code = opts.code || generateRoomCode();
    this.guests = new Map();       // guestId → { pc, channel, lastSeen, hello }
    this._nextGuestId = 1;
    this._pendingGuestId = null;   // for QR path: id of guest awaiting answer
    this._state = {};
    this._closed = false;

    const em = emitter();
    this._em = em;
    this.on  = em.on.bind(em);
    this.off = em.off.bind(em);

    this._pingTimer = setInterval(() => this._tickPings(), PING_INTERVAL_MS);
  }

  // ─── QR path (host = offerer) ───

  /** Generate an SDP offer to invite one new guest.
   *  Show the returned SDP as a QR code; guest scans + responds with answer. */
  async createOffer(){
    if (this._closed) throw new Error('Room closed');
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const guestId = this._nextGuestId++;

    // Host (offerer) creates the data channel. Guest sees it via ondatachannel.
    const channel = pc.createDataChannel('lofy', DATA_CHANNEL_OPTS);
    this._wireHostChannel(guestId, pc, channel);
    this._wirePcLifecycle(guestId, pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(pc);

    this.guests.set(guestId, { pc, channel, lastSeen: Date.now(), hello: null });
    this._pendingGuestId = guestId;
    return { guestId, offerSdp: pc.localDescription.sdp };
  }

  /** Host scanned the guest's answer QR — finish the handshake. */
  async acceptAnswer(guestId, answerSdp){
    const entry = this.guests.get(guestId);
    if (!entry) throw new Error('Unknown guest ' + guestId);
    await entry.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    if (this._pendingGuestId === guestId) this._pendingGuestId = null;
    return waitForChannelOpen(entry.channel);
  }

  // ─── PeerJS path (host = answerer) ───

  /** Accept an incoming offer (guest is offerer in this path).
   *  Returns the answer SDP. */
  async acceptOffer(offerSdp){
    if (this._closed) throw new Error('Room closed');
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const guestId = this._nextGuestId++;

    // Answerer listens for the offerer's data channel.
    pc.ondatachannel = (e) => {
      const entry = this.guests.get(guestId);
      if (entry){
        entry.channel = e.channel;
        this._wireHostChannel(guestId, pc, e.channel);
      }
    };
    this._wirePcLifecycle(guestId, pc);

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(pc);

    this.guests.set(guestId, { pc, channel: null, lastSeen: Date.now(), hello: null });
    return { guestId, answerSdp: pc.localDescription.sdp };
  }

  // ─── Shared wiring ───

  _wireHostChannel(guestId, pc, channel){
    channel.onopen = () => {
      // Send current state immediately so the new guest catches up
      if (Object.keys(this._state).length){
        jsonSend(channel, { type: 'state', ...this._state, t: performance.now() });
      }
      this._em.emit('guestjoin', { guestId, count: this.guestCount });
    };
    channel.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      const entry = this.guests.get(guestId);
      if (entry) entry.lastSeen = Date.now();
      this._handleGuestMessage(guestId, msg);
    };
    channel.onclose = () => this._removeGuest(guestId);
    channel.onerror = () => this._removeGuest(guestId);
  }

  _wirePcLifecycle(guestId, pc){
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed'){
        this._removeGuest(guestId);
      }
    };
  }

  _handleGuestMessage(guestId, msg){
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type){
      case 'hello': {
        const entry = this.guests.get(guestId);
        if (entry) entry.hello = msg;
        this._em.emit('guesthello', { guestId, name: msg.name });
        break;
      }
      case 'pong': {
        // Liveness only — clock sync derived guest-side from ping timestamps.
        break;
      }
      case 'bye': {
        this._removeGuest(guestId);
        break;
      }
      default:
        this._em.emit('message', { guestId, msg });
    }
  }

  _removeGuest(guestId){
    const entry = this.guests.get(guestId);
    if (!entry) return;
    try { entry.channel?.close(); } catch {}
    try { entry.pc?.close(); } catch {}
    this.guests.delete(guestId);
    this._em.emit('guestleave', { guestId, count: this.guestCount });
  }

  _tickPings(){
    if (this._closed) return;
    const t = performance.now();
    for (const entry of this.guests.values()){
      jsonSend(entry.channel, { type: 'ping', t });
    }
    // Drop guests that haven't replied in >GUEST_STALE_MS
    const cutoff = Date.now() - GUEST_STALE_MS;
    for (const [id, entry] of this.guests){
      if (entry.lastSeen < cutoff) this._removeGuest(id);
    }
  }

  // ─── Public broadcast API ───

  broadcastState(state){
    this._state = { ...this._state, ...state };
    const payload = { type: 'state', ...this._state, t: performance.now() };
    for (const entry of this.guests.values()){
      jsonSend(entry.channel, payload);
    }
  }

  broadcastBeat({ bpm, energy = 0, lowEnergy = 0 } = {}){
    const payload = {
      type: 'beat',
      bpm: bpm | 0,
      energy: +energy.toFixed(3),
      lowEnergy: +lowEnergy.toFixed(3),
      t: performance.now(),
    };
    for (const entry of this.guests.values()){
      jsonSend(entry.channel, payload);
    }
  }

  get guestCount(){ return this.guests.size; }

  close(){
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._pingTimer);
    for (const [, entry] of this.guests){
      jsonSend(entry.channel, { type: 'bye', t: performance.now() });
      try { entry.channel?.close(); } catch {}
      try { entry.pc?.close(); } catch {}
    }
    this.guests.clear();
    this._em.emit('close');
  }
}

// ─────────────────────────── RoomGuest ───────────────────────────

export class RoomGuest {
  constructor(opts = {}){
    this.name = opts.name || 'guest';
    this.pc = null;
    this.channel = null;
    this._closed = false;
    this._connected = false;
    this._clockOffsetMs = 0;      // host clock − local clock (ms)

    const em = emitter();
    this._em = em;
    this.on  = em.on.bind(em);
    this.off = em.off.bind(em);
  }

  // ─── QR path (guest = answerer) ───

  /** Guest scanned the host's offer QR. Returns guest's answer SDP. */
  async acceptOffer(offerSdp){
    this._ensureOpen();
    this.pc = new RTCPeerConnection(RTC_CONFIG);

    // As the answerer, we receive the data channel from the host.
    this.pc.ondatachannel = (e) => {
      this.channel = e.channel;
      this._wireGuestChannel(e.channel);
    };
    this._wirePcLifecycle();

    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await waitForIceGatheringComplete(this.pc);
    return this.pc.localDescription.sdp;
  }

  // ─── PeerJS path (guest = offerer) ───

  /** Guest dials the room — creates the offer SDP. */
  async createOffer(){
    this._ensureOpen();
    this.pc = new RTCPeerConnection(RTC_CONFIG);

    // Guest creates the data channel; host receives via ondatachannel.
    this.channel = this.pc.createDataChannel('lofy', DATA_CHANNEL_OPTS);
    this._wireGuestChannel(this.channel);
    this._wirePcLifecycle();

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await waitForIceGatheringComplete(this.pc);
    return this.pc.localDescription.sdp;
  }

  /** Guest receives host's answer SDP (PeerJS path completion). */
  async acceptAnswer(answerSdp){
    if (!this.pc) throw new Error('No outstanding offer');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    return waitForChannelOpen(this.channel);
  }

  // ─── Shared wiring ───

  _ensureOpen(){
    if (this._closed) throw new Error('Guest already closed');
  }

  _wirePcLifecycle(){
    this.pc.oniceconnectionstatechange = () => {
      const st = this.pc.iceConnectionState;
      if (st === 'failed' || st === 'disconnected' || st === 'closed'){
        if (!this._closed) this._em.emit('disconnect', { reason: st });
      }
    };
  }

  _wireGuestChannel(channel){
    channel.onopen = () => {
      this._connected = true;
      jsonSend(channel, { type: 'hello', name: this.name, t: performance.now() });
      this._em.emit('connect');
    };
    channel.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this._handleHostMessage(msg);
    };
    channel.onclose = () => {
      if (this._closed) return;
      this._connected = false;
      this._em.emit('disconnect', { reason: 'channel-closed' });
    };
    channel.onerror = () => {
      if (this._closed) return;
      this._em.emit('disconnect', { reason: 'channel-error' });
    };
  }

  _handleHostMessage(msg){
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type){
      case 'state':
        this._em.emit('state', msg);
        break;
      case 'beat':
        this._em.emit('beat', msg);
        break;
      case 'ping': {
        const ourT = performance.now();
        jsonSend(this.channel, { type: 'pong', t: ourT, hostT: msg.t });
        // Crude offset: hostT − ourT at receipt. Good enough for visual sync
        // since beat messages carry their own host timestamp, so guests just
        // need a stable bias.
        this._clockOffsetMs = msg.t - ourT;
        break;
      }
      case 'bye':
        this._em.emit('disconnect', { reason: 'host-left' });
        break;
      default:
        this._em.emit('message', msg);
    }
  }

  /** Local-clock estimate for a host timestamp (ms). */
  fromHostTime(hostMs){ return hostMs - this._clockOffsetMs; }
  /** Host-clock estimate for a local timestamp (ms). */
  toHostTime(localMs){ return localMs + this._clockOffsetMs; }
  get clockOffsetMs(){ return this._clockOffsetMs; }
  get connected(){ return this._connected; }

  send(msg){
    return jsonSend(this.channel, { ...msg, t: performance.now() });
  }

  leave(){
    if (this._closed) return;
    this._closed = true;
    jsonSend(this.channel, { type: 'bye', t: performance.now() });
    try { this.channel?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this._em.emit('close');
  }
}

/* ─────────── Console smoke test (DevTools, two tabs of lofy) ───────────

   --- Tab A (HOST) ---
   const { RoomHost } = await import('./js/sync.js');
   const host = new RoomHost();
   host.on('guestjoin', e => console.log('joined', e));
   const { guestId, offerSdp } = await host.createOffer();
   copy(offerSdp);                         // → clipboard

   --- Tab B (GUEST) ---
   const { RoomGuest } = await import('./js/sync.js');
   const guest = new RoomGuest();
   guest.on('state', m => console.log('state', m));
   guest.on('beat',  m => console.log('beat',  m));
   const answerSdp = await guest.acceptOffer(`<paste offerSdp>`);
   copy(answerSdp);                        // → clipboard

   --- Tab A ---
   await host.acceptAnswer(guestId, `<paste answerSdp>`);
   host.broadcastState({ mode: 'flash', palette: ['#ff2d87','#7a3cff','#00f0ff','#d8ff3a'] });
   host.broadcastBeat({ bpm: 128, energy: 0.7 });
   // → Tab B's console should log both messages.
*/
