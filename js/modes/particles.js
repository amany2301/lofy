/* lofy — Particle Storm mode */

let particles = [];
let maxParticles = 500;

export function setMaxParticles(n){ maxParticles = n; }

export function onBeatParticles(W, H, palette, energy){
  // energy: 0..1 — scales count and speed
  const count = 20 + Math.floor(40 * energy);
  const cx = W / 2, cy = H / 2;
  const speedBase = 1.5 + 5 * energy;
  for (let i = 0; i < count; i++){
    const ang = Math.random() * Math.PI * 2;
    const sp = speedBase * (0.6 + Math.random() * 0.8);
    particles.push({
      x: cx + (Math.random() - .5) * 12,
      y: cy + (Math.random() - .5) * 12,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: 1,
      decay: 0.006 + Math.random() * 0.014,
      size: 2 + Math.random() * 6,
      color: palette[Math.floor(Math.random() * palette.length)] || palette[0],
    });
  }
  if (particles.length > maxParticles) particles.splice(0, particles.length - maxParticles);
}

export function drawParticles(ctx, W, H){
  // No long trail — clean particles per spec
  ctx.fillStyle = 'rgba(10,10,13,0.30)';
  ctx.fillRect(0, 0, W, H);

  for (let i = particles.length - 1; i >= 0; i--){
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vx *= 0.985; p.vy *= 0.985;
    p.life -= p.decay;
    if (p.life <= 0){ particles.splice(i, 1); continue; }
    ctx.globalAlpha = p.life;
    ctx.fillStyle = p.color;
    ctx.shadowBlur = 12; ctx.shadowColor = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

export function resetParticles(){
  particles = [];
}
