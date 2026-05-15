/* lofy — QR-code signaling for Party Rooms (Day 2)
   ────────────────────────────────────────────────────────────
   Wraps qrcode-generator (encode) + jsQR (decode) so SDP offers/answers
   can be shuttled visually between two devices in the same room.

   Two challenges this file solves:

   1. SDP payloads are big.
      A WebRTC SDP with all ICE candidates is typically 2-5 KB — too
      large for a comfortable QR code. We gzip via CompressionStream
      and then base64-encode, which gets it down to ~600-1200 bytes
      (well inside a comfortable QR version 25-30).

   2. CDN deps must NOT load on app boot.
      qrcode-generator + jsQR together are ~20 KB. We lazy-inject the
      <script> tags only when Party Rooms is actually used. Until then
      the bundle stays at v1.3.1's size.

   API surface:
     loadQrLibs()              → Promise<void>  (idempotent)
     encodeSdpForQr(sdp)       → Promise<string>
     decodeSdpFromQr(text)     → Promise<string>
     renderQrToCanvas(text, canvas, sizePx)
     startCameraScan({onResult, onError, videoEl, signal?})
                               → returns Promise<() => void>  (stop function)

   The room-UI layer (Day 5) builds on these.
*/

// ─────────────────────── CDN loading (idempotent) ───────────────────────

const CDN_QRCODE  = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
const CDN_JSQR    = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

let _libsPromise = null;

export function loadQrLibs(){
  if (_libsPromise) return _libsPromise;
  _libsPromise = Promise.all([
    _injectScript(CDN_QRCODE, () => typeof window.qrcode === 'function'),
    _injectScript(CDN_JSQR,   () => typeof window.jsQR === 'function'),
  ]).then(() => {
    if (typeof window.qrcode !== 'function') throw new Error('qrcode-generator failed to load');
    if (typeof window.jsQR   !== 'function') throw new Error('jsQR failed to load');
  }).catch((err) => {
    _libsPromise = null;   // allow retry
    throw err;
  });
  return _libsPromise;
}

function _injectScript(src, isReady){
  return new Promise((resolve, reject) => {
    if (isReady && isReady()) return resolve();
    // De-dupe if a previous call already injected the tag
    const existing = document.querySelector(`script[data-lofy-cdn="${src}"]`);
    if (existing){
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Script load failed: ' + src)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.lofyCdn = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Script load failed: ' + src));
    document.head.appendChild(s);
  });
}

// ─────────────────────── SDP compression ───────────────────────

/** gzip → base64. Browser-native via CompressionStream (Chrome 80+,
 *  Safari 16.4+, Firefox 113+). Falls back to plain base64 on older. */
// Where the deep-link points — the app handles `#join=<payload>` in app.js.
const LOFY_APP_URL = (location.origin || 'https://lofy.vizleo.com') + '/app.html';
const JOIN_HASH    = '#join=';

/** Encode an SDP into a "lofy1:" base64+gzip payload. */
async function _toPayload(sdp){
  let compressed;
  if (typeof CompressionStream !== 'undefined'){
    const bytes = new TextEncoder().encode(sdp);
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes); writer.close();
    compressed = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  } else {
    compressed = new TextEncoder().encode(sdp);
  }
  let bin = '';
  for (let i = 0; i < compressed.length; i++) bin += String.fromCharCode(compressed[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'lofy1:' + b64;
}

async function _fromPayload(payload){
  let b64 = payload.slice('lofy1:'.length).replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (typeof DecompressionStream !== 'undefined'){
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(bytes); writer.close();
    const buf = await new Response(ds.readable).arrayBuffer();
    return new TextDecoder().decode(buf);
  }
  return new TextDecoder().decode(bytes);
}

/** Encode an SDP for a QR code. The host's OFFER is wrapped in a
 *  deep-link URL so a guest can scan it with their phone's NATIVE camera
 *  and have lofy open with the connection pre-loaded — no app install,
 *  no instructions needed. Pass {asUrl: false} for an "in-app only"
 *  payload (used for the guest's answer QR, since the host is already
 *  inside lofy when scanning it). */
export async function encodeSdpForQr(sdp, opts = {}){
  const payload = await _toPayload(sdp);
  return opts.asUrl === false ? payload : (LOFY_APP_URL + JOIN_HASH + payload);
}

/** Decode a QR scan. Accepts BOTH formats:
 *    - raw  : "lofy1:<base64>"
 *    - url  : "https://lofy.vizleo.com/app.html#join=lofy1:<base64>"
 *  Returns the original SDP. */
export async function decodeSdpFromQr(text){
  if (!text) throw new Error('Empty QR');
  let payload = text;
  // Try URL form first
  const idx = text.indexOf(JOIN_HASH);
  if (idx !== -1) payload = text.slice(idx + JOIN_HASH.length);
  // Strip any extra query/fragment chars
  payload = payload.split(/[&?]/)[0];
  if (!payload.startsWith('lofy1:')) throw new Error('Not a lofy QR code');
  return _fromPayload(payload);
}

/** Pull the `#join=...` payload from a URL hash on app boot. */
export function extractJoinPayloadFromUrl(){
  const idx = (location.hash || '').indexOf(JOIN_HASH);
  if (idx === -1) return null;
  const payload = location.hash.slice(idx + JOIN_HASH.length).split(/[&?]/)[0];
  return payload.startsWith('lofy1:') ? payload : null;
}

/** Decode a payload string (already in the "lofy1:..." form) into an SDP. */
export async function decodePayloadToSdp(payload){
  if (!payload || !payload.startsWith('lofy1:')) throw new Error('Bad payload');
  return _fromPayload(payload);
}

// ─────────────────────── QR rendering ───────────────────────

/** Render the QR for a string into a <canvas>. Auto-picks the smallest
 *  QR version that fits the data. Uses error-correction level 'L' (7%)
 *  for max density — scanning a screen is reliable. */
export function renderQrToCanvas(text, canvas, sizePx = 320){
  if (typeof window.qrcode !== 'function') throw new Error('QR lib not loaded');

  // Try increasing QR versions until one fits the data
  let qr;
  let lastErr;
  for (let v = 0; v <= 40; v++){
    try {
      qr = window.qrcode(v, 'L');
      qr.addData(text, 'Byte');
      qr.make();
      break;
    } catch (e){
      lastErr = e; qr = null;
    }
  }
  if (!qr) throw new Error('Payload too large for QR: ' + (lastErr?.message || ''));

  const count = qr.getModuleCount();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const px = Math.floor(sizePx * dpr);
  canvas.width = px;
  canvas.height = px;
  canvas.style.width  = sizePx + 'px';
  canvas.style.height = sizePx + 'px';

  const ctx = canvas.getContext('2d');
  const margin = 2;                       // quiet zone in modules
  const modules = count + margin * 2;
  const modSize = Math.floor(px / modules);
  const offset = Math.floor((px - modSize * modules) / 2);

  // White background (improves scanner contrast)
  ctx.fillStyle = '#f4f0e6';
  ctx.fillRect(0, 0, px, px);

  ctx.fillStyle = '#0a0a0d';
  for (let r = 0; r < count; r++){
    for (let c = 0; c < count; c++){
      if (qr.isDark(r, c)){
        ctx.fillRect(
          offset + (c + margin) * modSize,
          offset + (r + margin) * modSize,
          modSize, modSize,
        );
      }
    }
  }
  return { modules: count };
}

// ─────────────────────── Camera scanning ───────────────────────

/** Open the camera and run jsQR on every frame. When a QR is decoded,
 *  call onResult(text) once and stop the camera.
 *
 *  Returns a stop function. Caller should also call it on cancel/timeout.
 *
 *  Options:
 *    onResult(text)   — fires once, then scanning stops
 *    onError(err)     — fires if camera fails
 *    videoEl          — a <video> to display the live feed
 *    signal           — optional AbortSignal to cancel
 *    facingMode       — 'environment' (default) or 'user'
 */
export async function startCameraScan({ onResult, onError, videoEl, signal, facingMode = 'environment' }){
  if (typeof window.jsQR !== 'function') throw new Error('jsQR not loaded');
  if (!navigator.mediaDevices?.getUserMedia){
    onError && onError(new Error('Camera not supported on this browser'));
    return () => {};
  }

  let stream = null;
  let stopped = false;
  let raf = 0;

  // Off-screen canvas for pixel sampling
  const scanCanvas = document.createElement('canvas');
  const scanCtx = scanCanvas.getContext('2d', { willReadFrequently: true });

  function stop(){
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    if (stream){
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (videoEl){
      videoEl.pause();
      videoEl.srcObject = null;
    }
  }

  if (signal){
    if (signal.aborted){ stop(); return stop; }
    signal.addEventListener('abort', stop, { once: true });
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
    });
  } catch (err){
    onError && onError(err);
    stop();
    return stop;
  }

  videoEl.srcObject = stream;
  videoEl.setAttribute('playsinline', 'true');
  videoEl.muted = true;
  try { await videoEl.play(); } catch (err){ onError && onError(err); stop(); return stop; }

  function tick(){
    if (stopped) return;
    if (videoEl.readyState >= 2){
      const w = videoEl.videoWidth;
      const h = videoEl.videoHeight;
      if (w && h){
        // Downsample for speed — jsQR is fast but we don't need full 1080p
        const max = 640;
        const scale = Math.min(1, max / Math.max(w, h));
        const sw = Math.round(w * scale);
        const sh = Math.round(h * scale);
        scanCanvas.width = sw;
        scanCanvas.height = sh;
        scanCtx.drawImage(videoEl, 0, 0, sw, sh);
        const imageData = scanCtx.getImageData(0, 0, sw, sh);
        const code = window.jsQR(imageData.data, sw, sh, { inversionAttempts: 'dontInvert' });
        if (code && code.data){
          // Done — vibrate if supported, then call onResult and stop
          if (navigator.vibrate) { try { navigator.vibrate(60); } catch {} }
          const result = code.data;
          stop();
          onResult && onResult(result);
          return;
        }
      }
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  return stop;
}

/* ─────────── Console smoke test ───────────

   await import('/js/qr-signal.js').then(m => window.qrs = m);
   await window.qrs.loadQrLibs();

   // Round-trip test:
   const sdp = 'v=0\no=- 4 0 IN IP4 127.0.0.1\ns=-\nt=0 0\n...';
   const encoded = await qrs.encodeSdpForQr(sdp);
   const decoded = await qrs.decodeSdpFromQr(encoded);
   console.assert(decoded === sdp, 'round-trip failed');

   // Render a QR:
   const c = document.createElement('canvas');
   document.body.appendChild(c);
   qrs.renderQrToCanvas(encoded, c, 320);
*/
