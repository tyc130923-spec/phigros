const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {fixture}=require('./helpers/engine.cjs');
const source=fs.readFileSync('js/app.js','utf8');

function playable(notes){
  const f=fixture({nativeBlockTouchBlocked:()=>false,judgeTimingLead:0,specialJudgeDelay:0,keyboardInput:null});
  vm.runInContext(source.slice(source.indexOf('  function lowerBoundNumeric('),source.indexOf('  function eventValueFast(')),f.context);
  const p=f.probe;
  p.tryTap=f.context.Engine.prototype.tryTap;
  p.eventAudioTime=f.context.Engine.prototype.eventAudioTime;
  p.lineScreen=()=>({cx:500,cy:250,ux:1,uy:0});
  p.candidateScratch={};p.pendingJudge=new Set();p.judgeFeedIndex=0;
  p.noteItems=notes.map(n=>{const item={L:{id:0},n:{x:0,state:0,fake:false,...n}};item.n._item=item;return item;}).sort((a,b)=>a.n.time-b.n.time);
  p.noteTimes=Float64Array.from(p.noteItems,x=>x.n.time);
  p.commits=[];
  p.commit=(n,j,diff)=>{n.state=1;n.judge=['perfect','good','bad','miss'][j];p.pendingJudge.delete(n._item);p.commits.push({n,j,diff});};
  p.playSound=()=>{};p.hitEffect=()=>{};
  p.effects=[];p.badGhosts=[];p.nextHudPerf=p.nextProgressPerf=Infinity;
  return f;
}
function pointer(id=11,extra={}){return {pointerId:id,pointerType:'touch',clientX:500,clientY:250,timeStamp:1000,cancelable:true,preventDefault(){},...extra};}
function touch(id=1,extra={}){return {identifier:id,clientX:500,clientY:250,...extra};}
function start(p,t,stamp=1000,all=[t]){p.touchStart({changedTouches:[t],touches:all,timeStamp:stamp,cancelable:true,preventDefault(){}});}

test('an on-time Tap is not swallowed by a preceding unjudged Drag or Flick',()=>{
  for(const type of [2,4])for(const offset of [-.12,0,.12]){
    const {probe:p}=playable([{type,time:39.9},{type:1,time:40}]);
    p.time=40+offset;p.tryTap(-2,500,250,p.time);
    assert.equal(p.commits.length,1,`${type} before Tap at ${offset}`);
    assert.equal(p.commits[0].n.type,1);assert(p.commits[0].j<=1);
  }
});

test('pressing a special note still protects a following early-Bad Tap',()=>{
  const {probe:p}=playable([{type:4,time:40},{type:1,time:40.17}]);
  p.tryTap(-2,500,250,40);
  assert.equal(p.commits.length,0);assert.equal(p.inputStats.earlyGuard,1);
});

test('fallback Hold search keeps the original event time when guarding an early Tap',()=>{
  const {probe:p}=playable([{type:4,time:40},{type:1,time:40.17},{type:3,time:40.18,end:41}]);
  // At event time the Hold is outside Good; at dispatch time it would be valid.
  p.time=40.1;p.tryTap(-2,500,250,40);
  assert.equal(p.activeHolds.size,0);assert.equal(p.inputStats.accepted,0);
});

test('PointerEvent first scores once and hands the same contact to TouchEvent',()=>{
  const {probe:p,setNow}=playable([{type:1,time:40},{type:1,time:40.04}]);
  p.pointerDown(pointer());
  const original=p.pointer.get(11);original.noiseBlocked=true;
  setNow(1002);start(p,touch(),1002);
  start(p,touch(),1002);p.pointerDown(pointer());
  assert.equal(p.commits.length,1);assert.equal(p.inputStats.edges,1);
  assert.equal(p.pointer.size,1);assert.equal(p.pointer.get(-2),original);
  assert.equal(original.noiseBlocked,true,'noise-area latch survives handoff');
  assert.equal(p.nativePointerLinks.get(11),-2);
});

test('TouchEvent first also receives exactly one down edge',()=>{
  const {probe:p,setNow}=playable([{type:1,time:40},{type:1,time:40.04}]);
  start(p,touch());setNow(1002);p.pointerDown(pointer(11,{timeStamp:1002}));
  assert.equal(p.commits.length,1);assert.equal(p.inputStats.edges,1);
  assert.equal(p.pointer.size,1);assert.equal(p.nativePointerLinks.get(11),-2);
});

test('a missing touchstart still recognizes a short pointer-only press',()=>{
  const {probe:p}=playable([{type:1,time:40}]);
  p.pointerDown(pointer());p.pointerUp(pointer());
  assert.equal(p.commits.length,1);assert.equal(p.commits[0].j,0);
  assert.equal(p.pointer.size,0);assert.equal(p.nativePointerLinks.size,0);
});

test('native snapshot or move can adopt a fallback contact without scoring twice',()=>{
  for(const mode of ['snapshot','move']){
    const {probe:p,setNow}=playable([{type:1,time:40},{type:1,time:40.04}]);
    p.pointerDown(pointer());setNow(1004);
    const t=touch();
    if(mode==='snapshot')p.recoverNativeTouchSnapshot({touches:[t],timeStamp:1004},{synthesizeMissingDown:true});
    else p.touchMove({changedTouches:[t],touches:[t],timeStamp:1004});
    assert.equal(p.commits.length,1);assert.equal(p.inputStats.edges,1);assert.equal(p.pointer.size,1);
  }
});

test('multi-finger chords keep one edge and one contact for every finger',()=>{
  const {probe:p}=playable(Array.from({length:6},()=>({type:1,time:40})));
  const touches=Array.from({length:6},(_,i)=>touch(i,{clientX:400+i*35}));
  for(let i=0;i<6;i++)p.pointerDown(pointer(20+i,{clientX:touches[i].clientX}));
  p.touchStart({changedTouches:touches,touches,timeStamp:1000});
  assert.equal(p.commits.length,6);assert.equal(p.inputStats.edges,6);assert.equal(p.pointer.size,6);
  p.touchEnd({changedTouches:touches,touches:[],timeStamp:1001});
  assert.equal(p.pointer.size,0);assert.equal(p.nativePointerLinks.size,0);
});

test('real lift and reused Touch identifier permit the next rapid Tap',()=>{
  const {probe:p,setNow}=playable([{type:1,time:40},{type:1,time:40.04}]);
  p.pointerDown(pointer());start(p,touch());
  p.pointerUp(pointer());p.touchEnd({changedTouches:[touch()],touches:[],timeStamp:1010});
  setNow(1040);p.time=40.04;
  p.pointerDown(pointer(12,{timeStamp:1040}));start(p,touch(),1040);
  assert.equal(p.commits.length,2);assert.equal(p.inputStats.edges,2);assert.equal(p.pointer.size,1);
});

test('a new nearby pointer is not swallowed by an older native-only contact',()=>{
  const {probe:p,setNow}=playable([{type:1,time:40},{type:1,time:40.04}]);
  start(p,touch());setNow(1040);p.time=40.04;
  p.pointerDown(pointer(12,{timeStamp:1040}));
  const second=touch(2);start(p,second,1040,[touch(),second]);
  assert.equal(p.commits.length,2);assert.equal(p.inputStats.edges,2);assert.equal(p.pointer.size,2);
});

test('Hold ownership moves to native identifier without a second head or release',()=>{
  const {probe:p}=playable([{type:3,time:40,end:42}]);
  p.pointerDown(pointer());const n=p.noteItems[0].n;
  assert.equal(n.holdPointer,11);start(p,touch());
  assert.equal(n.holdPointer,-2);assert.equal(n.state,2);assert.equal(n.releaseAt,Infinity);
  assert.equal(p.activeHolds.size,1);assert.equal(p.inputStats.edges,1);
  p.pointerUp(pointer());assert.equal(p.pointer.size,0);assert.equal(n.releaseAt,1);
});

test('snapshot-first native edge is not repeated by its changedTouches entry',()=>{
  const {probe:p}=playable([{type:1,time:40},{type:1,time:40.04}]);
  p.recoverNativeTouchSnapshot({touches:[touch()],timeStamp:1000},{synthesizeMissingDown:true});
  start(p,touch());assert.equal(p.commits.length,1);assert.equal(p.inputStats.edges,1);
});

test('first observed pointer move reconstructs one missing down edge',()=>{
  const {probe:p}=playable([{type:1,time:40},{type:1,time:40.04}]);
  p.useNativeTouchInput=false;
  p.pointerMove(pointer(11,{buttons:1}));p.pointerMove(pointer(11,{buttons:1}));
  assert.equal(p.commits.length,1);assert.equal(p.inputStats.recovered,1);assert.equal(p.inputStats.edges,1);
});

test('epoch timestamps, invalid zero and future timestamps use the right clock origin',()=>{
  const {probe:p}=playable([]);
  assert.equal(p.eventPerformanceTime({timeStamp:1700000000950}),950);
  assert.equal(p.eventPerformanceTime({timeStamp:0}),1000);
  assert.equal(p.eventPerformanceTime({timeStamp:Infinity}),1000);
  assert.equal(p.eventPerformanceTime({timeStamp:5000}),1000);
  assert.equal(p.eventPerformanceTime({timeStamp:1004}),1000);
  assert.equal(p.eventAudioTime({timeStamp:0}),40);
});

test('a 400 ms queued input keeps its capture time and playback-rate conversion',()=>{
  const {probe:p}=playable([]);p.musicRate=1.5;
  assert(Math.abs(p.eventAudioTime({timeStamp:600})-39.4)<1e-10);
  assert.equal(p.inputStats.maxDispatchMs,400);
});

test('rAF cannot finalize Miss before an already queued on-time touch gets dispatched',()=>{
  const {probe:p,setNow}=playable([{type:1,time:40}]);
  p.time=40.4;setNow(1400);
  p.update(p.time,1400,p.time);
  assert.equal(p.commits.length,0);
  // The press physically occurred at 40.0, but its task waited behind a frame.
  p.pointerDown(pointer());assert.equal(p.commits.length,1);assert.equal(p.commits[0].j,0);
});

test('dispatch grace does not widen the window or turn an absent/late press into a hit',()=>{
  for(const sendLatePress of [false,true]){
    const {probe:p,setNow}=playable([{type:1,time:40}]);
    p.time=40.2;setNow(1200);p.update(p.time,1200,p.time);
    if(sendLatePress)p.pointerDown(pointer(11,{timeStamp:1200}));
    assert.equal(p.commits.length,0);
    p.time=40.25;setNow(1250);p.update(p.time,1250,p.time);
    assert.equal(p.commits.length,1);assert.equal(p.commits[0].j,3);
  }
});
