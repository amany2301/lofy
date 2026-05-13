/* lofy — landing page hero canvas + mode previews
   Synthesises a believable beat-driven signal at 128 BPM for the demo. */
(function(){
  const canvas = document.getElementById('heroCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const BPM_EL = document.getElementById('bpmVal');
  const PALETTE = ['#ff2d87','#7a3cff','#00f0ff','#d8ff3a','#ff9a1f'];
  let mode = 'spectrum';
  let W=0, H=0, DPR=1;
  let particles = [];
  let lastBeat = 0, flashAlpha = 0, flashColor = PALETTE[0], beatIx = 0;
  let bpm = 128;

  function resize(){
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    const r = canvas.getBoundingClientRect();
    W = r.width; H = r.height;
    canvas.width = W * DPR; canvas.height = H * DPR;
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  resize();
  window.addEventListener('resize', resize);

  const BARS = 64;
  const bands = new Float32Array(BARS);

  function tick(t){
    const period = 60000 / bpm;
    const phase = (t % period) / period;
    const beatEnv = Math.max(0, 1 - phase) ** 2;
    const onBeat = phase < 0.04 && (t - lastBeat) > period * 0.7;
    if (onBeat){
      lastBeat = t; beatIx++;
      flashColor = PALETTE[beatIx % PALETTE.length];
      flashAlpha = 1;
      const cx = W/2, cy = H/2;
      const n = 28 + Math.floor(Math.random()*22);
      for (let i=0;i<n;i++){
        const ang = Math.random()*Math.PI*2;
        const sp = 1.5 + Math.random()*4.5;
        particles.push({
          x:cx, y:cy,
          vx:Math.cos(ang)*sp, vy:Math.sin(ang)*sp,
          life:1, decay:.008 + Math.random()*.014,
          size:2 + Math.random()*5,
          color: PALETTE[Math.floor(Math.random()*PALETTE.length)]
        });
      }
      if (particles.length > 600) particles.splice(0, particles.length - 600);
    }
    for (let i=0;i<BARS;i++){
      const fr = i/BARS;
      const lowBias = Math.max(0, 1 - fr*1.4) * beatEnv * 0.9;
      const noiseTarget = (0.15 + Math.random()*0.35) * (0.5 + (1-fr)*0.7);
      const target = Math.min(1, lowBias + noiseTarget + beatEnv*0.2*Math.random());
      bands[i] = bands[i] + (target - bands[i]) * 0.18;
    }
  }

  function drawSpectrum(){
    ctx.fillStyle = 'rgba(10,10,13,0.22)';
    ctx.fillRect(0,0,W,H);
    const bw = W / BARS;
    for (let i=0;i<BARS;i++){
      const v = bands[i];
      const h = v * H * 0.85;
      const x = i * bw;
      const t = i/BARS;
      const col = t < .33 ? '#ff2d87' : t < .66 ? '#7a3cff' : '#00f0ff';
      ctx.fillStyle = col;
      ctx.shadowBlur = 14; ctx.shadowColor = col;
      ctx.fillRect(x+1, H-h, bw-2, h);
      ctx.shadowBlur = 0;
      const peakY = H - h - 6;
      ctx.fillStyle = '#f4f0e6';
      ctx.fillRect(x+1, peakY, bw-2, 2);
    }
  }

  function drawFlash(){
    ctx.fillStyle = 'rgba(10,10,13,0.18)';
    ctx.fillRect(0,0,W,H);
    if (flashAlpha > 0){
      ctx.fillStyle = flashColor;
      ctx.globalAlpha = flashAlpha * 0.75;
      ctx.fillRect(0,0,W,H);
      ctx.globalAlpha = 1;
      flashAlpha = Math.max(0, flashAlpha - 0.05);
    }
    for (let i=0;i<6;i++){
      const x = (Math.sin(performance.now()*0.0004 + i*1.7)*0.5+0.5)*W;
      const y = (Math.cos(performance.now()*0.0003 + i*2.1)*0.5+0.5)*H;
      ctx.fillStyle = PALETTE[i%PALETTE.length];
      ctx.globalAlpha = .35;
      ctx.beginPath(); ctx.arc(x,y,18+Math.sin(performance.now()*0.002+i)*6,0,Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function drawParticles(){
    ctx.fillStyle = 'rgba(10,10,13,0.30)';
    ctx.fillRect(0,0,W,H);
    for (let i=particles.length-1;i>=0;i--){
      const p = particles[i];
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.985; p.vy *= 0.985;
      p.life -= p.decay;
      if (p.life <= 0){ particles.splice(i,1); continue; }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.shadowBlur = 12; ctx.shadowColor = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size*p.life, 0, Math.PI*2); ctx.fill();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }

  function render(t){
    tick(t);
    if (mode === 'spectrum') drawSpectrum();
    else if (mode === 'flash') drawFlash();
    else drawParticles();
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  setInterval(()=>{ const j = 128 + Math.round((Math.random()-.5)*2); if (BPM_EL) BPM_EL.textContent = j; bpm = j; }, 2400);

  document.querySelectorAll('.mode-pill').forEach(b=>{
    b.addEventListener('click', ()=>{
      document.querySelectorAll('.mode-pill').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      mode = b.dataset.mode;
      particles = []; flashAlpha = 0;
    });
  });
})();

/* ==== Mini preview canvases ==== */
function miniSpectrum(id){
  const c=document.getElementById(id); if(!c) return;
  const x=c.getContext('2d');
  let W,H,DPR=Math.min(devicePixelRatio||1,2);
  function size(){const r=c.getBoundingClientRect();W=r.width;H=r.height;c.width=W*DPR;c.height=H*DPR;x.setTransform(DPR,0,0,DPR,0,0)}
  size(); window.addEventListener('resize',size);
  const N=32, b=new Float32Array(N);
  function frame(t){
    x.fillStyle='rgba(17,17,24,0.3)';x.fillRect(0,0,W,H);
    const bw=W/N;
    for(let i=0;i<N;i++){
      const target=Math.max(0.1, Math.sin(t*0.003 + i*0.4)*0.5+0.5)*(1-i/N*0.4);
      b[i]+=(target-b[i])*0.15;
      const h=b[i]*H*0.9;
      const col=i<N/3?'#ff2d87':i<2*N/3?'#7a3cff':'#00f0ff';
      x.fillStyle=col;x.fillRect(i*bw+1,H-h,bw-2,h);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function miniFlash(id){
  const c=document.getElementById(id); if(!c) return;
  const x=c.getContext('2d');
  let W,H,DPR=Math.min(devicePixelRatio||1,2);
  function size(){const r=c.getBoundingClientRect();W=r.width;H=r.height;c.width=W*DPR;c.height=H*DPR;x.setTransform(DPR,0,0,DPR,0,0)}
  size(); window.addEventListener('resize',size);
  const cols=['#ff2d87','#d8ff3a','#00f0ff','#ff9a1f'];let i=0,a=0,last=0;
  function frame(t){
    x.fillStyle='rgba(17,17,24,0.25)';x.fillRect(0,0,W,H);
    if(t-last>470){last=t;i=(i+1)%cols.length;a=1;}
    if(a>0){x.globalAlpha=a*.8;x.fillStyle=cols[i];x.fillRect(0,0,W,H);x.globalAlpha=1;a-=.05;}
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function miniParticles(id){
  const c=document.getElementById(id); if(!c) return;
  const x=c.getContext('2d');
  let W,H,DPR=Math.min(devicePixelRatio||1,2);
  function size(){const r=c.getBoundingClientRect();W=r.width;H=r.height;c.width=W*DPR;c.height=H*DPR;x.setTransform(DPR,0,0,DPR,0,0)}
  size(); window.addEventListener('resize',size);
  let p=[], last=0;
  const cols=['#ff2d87','#7a3cff','#00f0ff','#d8ff3a'];
  function frame(t){
    x.fillStyle='rgba(17,17,24,0.3)';x.fillRect(0,0,W,H);
    if(t-last>470){
      last=t;
      for(let i=0;i<14;i++){const a=Math.random()*Math.PI*2,s=1+Math.random()*2;p.push({x:W/2,y:H/2,vx:Math.cos(a)*s,vy:Math.sin(a)*s,l:1,c:cols[Math.floor(Math.random()*cols.length)]})}
    }
    for(let i=p.length-1;i>=0;i--){const q=p[i];q.x+=q.vx;q.y+=q.vy;q.l-=.02;if(q.l<=0){p.splice(i,1);continue}x.globalAlpha=q.l;x.fillStyle=q.c;x.beginPath();x.arc(q.x,q.y,3*q.l,0,Math.PI*2);x.fill()}
    x.globalAlpha=1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
miniSpectrum('vis1'); miniFlash('vis2'); miniParticles('vis3');
