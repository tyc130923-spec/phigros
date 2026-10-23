/* Opening cues measured from the user's 2026-10-22 reference recording. */
(() => {
  'use strict';
  const cues = globalThis.PhiHostedManifest.opening;
  const home = document.getElementById('refHome');
  const audio = new Audio(new URL(cues.audio, document.baseURI).href);
  audio.loop = true; audio.preload = 'auto'; audio.setAttribute('playsinline', '');
  audio.id='openingAudio';audio.hidden=true;home.appendChild(audio);
  const canvas = document.getElementById('openingParticles'), ctx = canvas.getContext('2d');
  const sound = document.getElementById('openingSound');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let raf = 0, fallback = performance.now(), seenTitle = false, skipStudio = false, visible = true, suspended = false, blocked=false;
  let width = 682, height = 512, scale = 1;
  const clamp = value => Math.max(0, Math.min(1, value));
  const particles = Array.from({length: 42}, (_, i) => ({x: ((i * 193 + 79) % 997) / 997, y: ((i * 137 + 71) % 991) / 991, size: 1 + (i % 4) * .45, speed: .004 + (i % 5) * .0018}));
  function resize() {
    width=home.clientWidth||innerWidth;height=home.clientHeight||innerHeight;scale=Math.min(1.5,devicePixelRatio||1);
    canvas.width=Math.round(width*scale);canvas.height=Math.round(height*scale);
  }
  function draw(time) {
    ctx.setTransform(scale,0,0,scale,0,0);ctx.clearRect(0,0,width,height);
    if(home.dataset.stage!=='title'||reduced)return;
    const u=width/682,y=height/512,beat=time/(60/109.5);
    const mesh=Math.pow(Math.max(0,Math.sin((beat-12)*Math.PI/8)),5)*.48;
    ctx.lineWidth=.7*u;
    const step=138*u,vertical=80*y,offset=40*Math.sin(beat*.09)*u;
    for(let row=-1;row<8;row++)for(let col=2;col<7;col++){
      const x=col*step+(row%2)*step/2-160*u+offset,py=row*vertical;
      const proximity=clamp((x-width*.38)/(width*.36));
      ctx.strokeStyle=`rgba(150,235,246,${mesh*proximity})`;
      ctx.beginPath();ctx.moveTo(x,py);ctx.lineTo(x+step,py);ctx.lineTo(x+step/2,py+vertical);ctx.closePath();ctx.stroke();
      if(mesh>.05){ctx.fillStyle=`rgba(182,249,255,${mesh*proximity})`;ctx.fillRect(x-1*u,py-1*y,2*u,2*y);}
    }
    for(const p of particles){
      const px=(.52+p.x*.48)*width,py=((p.y-time*p.speed)%1+1)%1*height;
      const alpha=.22+.5*(.5+.5*Math.sin(time*1.7+p.x*19));
      ctx.fillStyle=`rgba(235,250,255,${alpha})`;ctx.shadowColor='#b5f8ff';ctx.shadowBlur=5*u;
      ctx.fillRect(px,py,p.size*u,p.size*u);
    }
    ctx.shadowBlur=0;
  }
  function frame() {
    raf=0;if(!visible)return;
    const time=blocked?(performance.now()-fallback)/1000:audio.currentTime;
    if(time>=cues.titleAt)seenTitle=true;
    const stage=skipStudio||seenTitle?'title':time>=cues.warningAt?'warning':'studio';
    home.dataset.stage=stage;
    const titleProgress=skipStudio||(seenTitle&&time<cues.titleAt)?1:clamp((time-cues.titleAt)/(cues.titleSettledAt-cues.titleAt));
    home.style.setProperty('--opening-reveal',String(skipStudio||seenTitle&&time<cues.titleAt?1:titleProgress));
    home.style.setProperty('--opening-blur',`${reduced?0:(1-titleProgress)*12}px`);
    home.style.setProperty('--opening-prompt',String(.78+.22*Math.cos(time/(60/109.5)*Math.PI)));
    home.style.setProperty('--opening-cue',String(stage==='studio'?clamp(time/.45)*clamp((3.5-time)/.5):stage==='warning'?clamp((time-3.35)/.4)*clamp((8.0-time)/.45):1));
    draw(time);raf=requestAnimationFrame(frame);
  }
  function animate(){if(!raf&&visible)raf=requestAnimationFrame(frame);}
  function play(from=0) {
    if(!visible)return;
    blocked=false;if(from===0&&!skipStudio)seenTitle=false;
    try{audio.currentTime=from;}catch{}
    fallback=performance.now()-from*1000;
    const attempt=audio.play();
    Promise.resolve(attempt).then(()=>{blocked=false;sound.hidden=true;},()=>{blocked=true;fallback=performance.now()-from*1000;sound.hidden=false;});
    animate();
  }
  function show(initial=false) {
    visible=true;skipStudio=!initial;seenTitle=!initial;resize();
    if(skipStudio)home.dataset.stage='title';
    play(initial?0:cues.titleSettledAt);
  }
  function stop(){visible=false;audio.pause();if(raf)cancelAnimationFrame(raf);raf=0;}
  sound.onclick=event=>{event.stopPropagation();play(home.dataset.stage==='title'?cues.titleSettledAt:0);};
  window.addEventListener('resize',resize,{passive:true});
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden){suspended=visible;audio.pause();if(raf)cancelAnimationFrame(raf);raf=0;}
    else if(suspended&&visible){suspended=false;fallback=performance.now()-audio.currentTime*1000;Promise.resolve(audio.play()).catch(()=>{sound.hidden=false;});animate();}
  });
  globalThis.PhiOpening=Object.freeze({show,stop,enableFromGesture:()=>play(0),readyForStart:()=>home.dataset.stage==='title',audio,cues});
  const bypass=new URLSearchParams(location.search).has('skipIntro')||new URLSearchParams(location.search).has('phiSelfTest');
  if(!bypass)show(true);else stop();
})();
