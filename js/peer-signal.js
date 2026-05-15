/* lofy — PeerJS-broker signaling for Party Rooms (Day 3)
   ────────────────────────────────────────────────────────────
   Free public broker at peerjs.com/api/peerjs handles the ~1-second
   WebRTC handshake; everything else is direct peer-to-peer.

   Why not just call window.RTCPeerConnection ourselves?
     We could — but then we'd need to write a signaling server. PeerJS
     gives us NAT-aware signaling for free and we don't owe them any
     ongoing payment. The library is ~40 KB minified, lazy-loaded only
     when the user opts into the remote-code path.

   API surface:
     loadPeerJs()                   → Promise<void>  (idempotent CDN load)
     attachHostToBroker(host, code) → returns { peer, disconnect }
       host    : RoomHost instance from js/sync.js
       code    : 4-letter alphanumeric (NOT including the 'lofy-' prefix)
       Returns the underlying Peer plus a cleanup fn.
     joinViaBroker(guest, code)     → Promise<void>
       guest   : RoomGuest instance from js/sync.js
       code    : 4-letter code typed by the user
       Resolves once the data channel is open (or rejects on failure).

   Why two entry points instead of one?
     The host LISTENS on the broker (accepts incoming guests).
     The guest DIALS via the broker (one-shot connection).
     They have opposite directionality.

   Naming convention:
     A 4-letter room code 'XYZW' becomes the PeerJS ID 'lofy-XYZW'.
     The prefix prevents accidental collision with other PeerJS apps.
*/

const CDN_PEERJS = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
const ID_PREFIX  = 'lofy-';
const CONNECT_TIMEOUT_MS = 12000;

let _peerJsPromise = null;

export function loadPeerJs(){
  if (_peerJsPromise) return _peerJsPromise;
  _peerJsPromise = new Promise((resolve, reject) => {
    if (typeof window.Peer === 'function') return resolve();
    const existing = document.querySelector(`script[data-lofy-cdn="${CDN_PEERJS}"]`);
    if (existing){
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('PeerJS load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = CDN_PEERJS;
    s.async = true;
    s.dataset.lofyCdn = CDN_PEERJS;
    s.onload = () => {
      if (typeof window.Peer === 'function') resolve();
      else reject(new Error('PeerJS loaded but window.Peer is undefined'));
    };
    s.onerror = () => reject(new Error('PeerJS CDN unreachable'));
    document.head.appendChild(s);
  }).catch((err) => {
    _peerJsPromise = null;        // allow retry on next call
    throw err;
  });
  return _peerJsPromise;
}

/** Host opens a listening peer at ID 'lofy-<code>'. Each incoming
 *  PeerJS DataConnection is converted into a RoomHost guest via the
 *  shared RTCPeerConnection wiring.
 *
 *  Returns { peer, disconnect }.
 */
export async function attachHostToBroker(host, code){
  await loadPeerJs();
  const peerId = ID_PREFIX + code;

  return new Promise((resolve, reject) => {
    let resolved = false;
    let peer;
    try {
      peer = new window.Peer(peerId, {
        debug: 0,
        // Default PeerJS cloud (peerjs.com) — free public broker.
        // If our chosen ID is taken, PeerJS fires 'unavailable-id'.
      });
    } catch (err){
      reject(err);
      return;
    }

    const onOpen = (id) => {
      if (resolved) return;
      resolved = true;
      // PeerJS-side connection handler — fires once per guest who dials in
      peer.on('connection', (conn) => {
        // conn is a DataConnection — we plug its underlying RTCPeerConnection
        // into RoomHost so the rest of the broadcast / state pipeline reuses
        // the existing wiring. PeerJS internally manages the SDP exchange
        // through its broker.
        _adoptPeerJsConnectionIntoHost(host, conn);
      });
      resolve({
        peer,
        disconnect: () => { try { peer.destroy(); } catch {} },
      });
    };

    const onError = (err) => {
      if (resolved) return;
      resolved = true;
      try { peer.destroy(); } catch {}
      if (err && err.type === 'unavailable-id'){
        reject(new Error('Room code already in use — try another'));
      } else if (err && err.type === 'network'){
        reject(new Error('Party Rooms broker unreachable — check connection'));
      } else {
        reject(err || new Error('PeerJS error'));
      }
    };

    peer.on('open', onOpen);
    peer.on('error', onError);

    // Hard timeout if PeerJS just hangs
    setTimeout(() => {
      if (!resolved){
        resolved = true;
        try { peer.destroy(); } catch {}
        reject(new Error('Party Rooms broker timed out'));
      }
    }, CONNECT_TIMEOUT_MS);
  });
}

/** Bridge a PeerJS DataConnection into a RoomHost as a new guest.
 *  We can't use host.acceptOffer() here because PeerJS abstracts the
 *  SDP exchange away — but the data channel events match what RoomHost
 *  expects, so we plug straight in. */
function _adoptPeerJsConnectionIntoHost(host, conn){
  // Lazy assign a guest id — same monotonic counter the manual paths use.
  const guestId = host._nextGuestId++;

  // Mock the same { pc, channel, lastSeen, hello } shape RoomHost stores.
  // PeerJS's `conn.peerConnection` is the underlying RTCPeerConnection.
  const entry = {
    pc: conn.peerConnection,
    channel: null,     // populated on conn.open
    lastSeen: Date.now(),
    hello: null,
  };
  host.guests.set(guestId, entry);

  conn.on('open', () => {
    // Translate PeerJS conn into a faux RTCDataChannel surface — we
    // implement enough of the DataChannel API for RoomHost to be happy:
    //   - readyState = 'open' once conn is open
    //   - send(jsonString)
    //   - onmessage / onopen / onclose / onerror handlers
    // Easier path: wire conn.on('data', ...) → RoomHost's message handler.
    const proxy = {
      get readyState(){ return conn.open ? 'open' : 'closed'; },
      send(text){ conn.send(text); },
      close(){ try { conn.close(); } catch {} },
      // These are set by RoomHost._wireHostChannel — we redirect them:
      _onmessage: null, _onopen: null, _onclose: null, _onerror: null,
      set onmessage(fn){ this._onmessage = fn; },
      set onopen(fn){ this._onopen = fn; if (conn.open) try { fn(); } catch {} },
      set onclose(fn){ this._onclose = fn; },
      set onerror(fn){ this._onerror = fn; },
    };
    entry.channel = proxy;

    // Now run the same wiring RoomHost uses for QR-path channels.
    // This sets up onopen (which fires the 'guestjoin' event + sends state),
    // onmessage, onclose, onerror.
    host._wireHostChannel(guestId, conn.peerConnection, proxy);

    // PeerJS's onopen has already fired by the time we attached, but the
    // proxy's _onopen setter triggers immediately if open is true (above).
    // PeerJS data events:
    conn.on('data', (data) => {
      proxy._onmessage && proxy._onmessage({ data });
    });
    conn.on('close', () => {
      proxy._onclose && proxy._onclose();
    });
    conn.on('error', (err) => {
      proxy._onerror && proxy._onerror(err);
    });
  });

  conn.on('error', () => {
    host._removeGuest(guestId);
  });
}

/** Guest dials a host's PeerJS ID — direct one-shot.
 *  Resolves when the data channel is open; rejects on timeout/failure. */
export async function joinViaBroker(guest, code){
  await loadPeerJs();
  const targetId = ID_PREFIX + code;

  return new Promise((resolve, reject) => {
    let resolved = false;
    let peer;
    try {
      peer = new window.Peer({ debug: 0 });
    } catch (err){ reject(err); return; }

    const fail = (err) => {
      if (resolved) return;
      resolved = true;
      try { peer.destroy(); } catch {}
      const t = err && err.type;
      if (t === 'peer-unavailable') reject(new Error('Room code not found — check spelling'));
      else if (t === 'network')     reject(new Error('Party Rooms broker unreachable'));
      else reject(err || new Error('Failed to join'));
    };

    peer.on('error', fail);
    peer.on('open', () => {
      const conn = peer.connect(targetId, { reliable: false });

      conn.on('open', () => {
        if (resolved) return;
        resolved = true;
        _adoptPeerJsConnectionIntoGuest(guest, conn);
        resolve();
      });

      conn.on('error', fail);
    });

    setTimeout(() => fail(new Error('Connection timed out')), CONNECT_TIMEOUT_MS);
  });
}

/** Bridge a PeerJS DataConnection into a RoomGuest. */
function _adoptPeerJsConnectionIntoGuest(guest, conn){
  guest.pc = conn.peerConnection;

  // Same faux-DataChannel shim as host side.
  const proxy = {
    get readyState(){ return conn.open ? 'open' : 'closed'; },
    send(text){ conn.send(text); },
    close(){ try { conn.close(); } catch {} },
    _onmessage: null, _onopen: null, _onclose: null, _onerror: null,
    set onmessage(fn){ this._onmessage = fn; },
    set onopen(fn){ this._onopen = fn; if (conn.open) try { fn(); } catch {} },
    set onclose(fn){ this._onclose = fn; },
    set onerror(fn){ this._onerror = fn; },
  };
  guest.channel = proxy;
  guest._wireGuestChannel(proxy);

  conn.on('data', (data) => {
    proxy._onmessage && proxy._onmessage({ data });
  });
  conn.on('close', () => {
    proxy._onclose && proxy._onclose();
  });
  conn.on('error', (err) => {
    proxy._onerror && proxy._onerror(err);
  });
}

/* ─────────── Console smoke test ───────────

   --- Tab A (HOST) ---
   const { RoomHost } = await import('/js/sync.js');
   const { attachHostToBroker } = await import('/js/peer-signal.js');
   const host = new RoomHost({ code: 'TEST' });
   host.on('guestjoin', e => console.log('joined:', e));
   const { disconnect } = await attachHostToBroker(host, 'TEST');
   // Wait for guest...

   --- Tab B (GUEST) ---
   const { RoomGuest } = await import('/js/sync.js');
   const { joinViaBroker } = await import('/js/peer-signal.js');
   const guest = new RoomGuest();
   guest.on('state', m => console.log('state:', m));
   guest.on('beat',  m => console.log('beat:',  m));
   guest.on('connect', () => console.log('connected'));
   await joinViaBroker(guest, 'TEST');

   --- Tab A ---
   host.broadcastState({ mode: 'flash', palette: ['#ff2d87'] });
   host.broadcastBeat({ bpm: 128, energy: 0.7 });
   // → Tab B logs both
*/
