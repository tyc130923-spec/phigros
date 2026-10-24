const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('./helpers/engine.cjs');
function clock(){
  const f=fixture({SYNC_STALL_GUARD:.09}),p=f.probe;
  p.syncClock=f.context.Engine.prototype.syncClock;
  Object.assign(p,{musicUsingWebAudio:false,clockReady:false});
  Object.assign(p.audio,{currentTime:10,readyState:4,duration:160,playbackRate:1,paused:false,seeking:false});
  p.syncClock(true);return f;
}
test('a media stall drops an old predicted lead instead of holding judgement ahead of music',()=>{
  const {probe:p,setNow}=clock();p.clockValue=10.3;p.audio.readyState=2;setNow(1010);
  assert.equal(p.syncClock(),10);assert.equal(p.clockDrift,0);
});
test('an unadvanced media clock freezes even if the browser still advertises readyState 4',()=>{
  const {probe:p,setNow}=clock();
  for(let t=1010;t<=1080;t+=10){setNow(t);assert(p.syncClock()<=10.0250001);}
  setNow(1120);assert.equal(p.syncClock(),10);
  p.audio.currentTime=10.12;setNow(1130);assert(Math.abs(p.syncClock()-10.12)<.001);
});
test('120 Hz interpolation follows quantized media samples without accumulating startup drift',()=>{
  const {probe:p,setNow}=clock();let previous=10;
  for(let i=1;i<=240;i++){
    const elapsed=i/120;p.audio.currentTime=10+Math.floor(elapsed*60)/60;setNow(1000+elapsed*1000);
    const value=p.syncClock();assert(value>=previous-.005);assert(value-p.audio.currentTime<=.0250001);assert(Math.abs(value-(10+elapsed))<.026);previous=value;
  }
});
test('seeks and paused media return to the actual position without a monotonic-clock trap',()=>{
  const {probe:p,setNow}=clock();p.clockValue=40;p.audio.currentTime=2;p.audio.seeking=true;setNow(1100);
  assert.equal(p.syncClock(),2);p.audio.seeking=false;p.audio.paused=true;setNow(1200);assert.equal(p.syncClock(),2);
});
