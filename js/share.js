/* lofy — preset URL state sharing
   Encodes mode + palette + sliders into a compact URL hash so users can
   paste a link and land on the exact same look. Hash form:
     #m=flash&p=ff2d87,7a3cff,00f0ff,d8ff3a&s=6&r=8
*/

const MODE_VALID = new Set(['spectrum', 'flash', 'particles']);

function cleanHex(c){
  const m = String(c || '').match(/[0-9a-fA-F]{6}/);
  return m ? m[0].toLowerCase() : null;
}

export function encodeState({ mode, palette, sens, react }){
  const parts = [];
  if (mode && MODE_VALID.has(mode)) parts.push(`m=${mode}`);
  if (Array.isArray(palette) && palette.length){
    const hexes = palette.map(c => cleanHex(c)).filter(Boolean).slice(0, 4);
    if (hexes.length) parts.push(`p=${hexes.join(',')}`);
  }
  if (sens  != null) parts.push(`s=${Math.max(1, Math.min(10, +sens|0))}`);
  if (react != null) parts.push(`r=${Math.max(1, Math.min(10, +react|0))}`);
  return parts.join('&');
}

export function decodeState(hash){
  if (!hash) return null;
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const out = {};
  for (const seg of h.split('&')){
    const [k, v] = seg.split('=');
    if (!k || v == null) continue;
    if (k === 'm' && MODE_VALID.has(v)) out.mode = v;
    else if (k === 'p'){
      const hexes = v.split(',').map(cleanHex).filter(Boolean);
      if (hexes.length) out.palette = hexes.map(h => '#' + h);
    }
    else if (k === 's'){ const n = +v; if (n >= 1 && n <= 10) out.sens = n; }
    else if (k === 'r'){ const n = +v; if (n >= 1 && n <= 10) out.react = n; }
  }
  return Object.keys(out).length ? out : null;
}

export function buildShareUrl({ mode, palette, sens, react }){
  const hash = encodeState({ mode, palette, sens, react });
  const base = location.origin + location.pathname;
  return hash ? `${base}#${hash}` : base;
}

export async function copyToClipboard(text){
  if (navigator.clipboard?.writeText){
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  // fallback
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch {}
  ta.remove();
  return ok;
}
