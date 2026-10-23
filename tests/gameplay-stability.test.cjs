const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// Exercise the shipped Engine methods without initializing the app or a GPU.
const source=fs.readFileSync('js/app.js','utf8');
const engineSource=source.slice(source.indexOf('  class Engine {'),source.indexOf('  let resultArtworkURL'));
class ElementMock { closest(){return null;} }
function fixture(overrides={}){
  let now=1000;
  const elements=new Map();
  const node=id=>{
    if(!elements.has(id)){
      const classes=new Set(['hidden']);
      elements.set(id,{dataset:{},style:{},classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),toggle(){},contains:x=>classes.has(x)}});
    }
    return elements.get(id);
  };
  const context=vm.createContext({console,AbortController,DOMException,Blob,URL,setTimeout,clearTimeout,
    performance:{now:()=>now},document:{hidden:false},Element:ElementMock,
    $:node,engine:null,sleep:async()=>{},withTimeout:p=>p,
    PhiHostedMedia:{bufferedAhead:audio=>audio.ahead},
    clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),touchSensitivity:1,
    FLICK_SPEED:138,FLICK_TRAVEL:5.5,FLICK_REARM_MS:58,FLICK_REARM_TRAVEL_GAIN:.42,
    MULTITOUCH_CANCEL_GRACE:.38,POINTER_DUPLICATE_EPS_MS:.08,POINTER_DUPLICATE_EPS_PX:.04,
    Diagnostics:{warn(){}},toast:()=>{},...overrides});
  vm.runInContext(engineSource+'\nglobalThis.Engine=Engine;',context);
  const probe=Object.create(context.Engine.prototype);
  Object.assign(probe,{running:true,paused:false,starting:false,resumePending:false,autoplay:false,
    transitionToken:1,useNativeTouchInput:true,pointer:new Map(),pointerPool:[],activeHolds:new Set(),
    nativeTouchBlocked:new Set(),nativeTouchLiveIds:new Set(),nativeTouchChangedIds:new Set(),
    inputRect:{left:0,top:0,width:1000,height:500},viewX:0,viewY:0,viewScale:1,w:1000,h:500,
    pointScratchA:{},pointScratchB:{},chart:{kind:'pgr'},streamBuffering:false,
    audio:{ahead:0,readyState:2,currentTime:40,paused:false,playCalls:0,play(){this.playCalls++;this.paused=false;return Promise.resolve();}},
    musicDuration:()=>160,musicCurrentTime:()=>40,eventAudioTime:()=>40,
    cancelLoop(){this.cancelledLoops=(this.cancelledLoops||0)+1;},pauseMusic(){this.audio.paused=true;},
    syncClock(){},draw(){},scheduleLoop(){this.scheduledLoops=(this.scheduledLoops||0)+1;},
    pause(){throw Error('buffer recovery must not call manual pause');},
    resume(){throw Error('buffer recovery must not call countdown resume');},
    clearPointerStates(){throw Error('buffer recovery must preserve contacts');},
    tryTap(){},tryArmDrag(){},armDragAlongPath(){},armFlickAlongPath(){}});
  Object.defineProperty(probe,'time',{value:40,writable:true});
  context.engine=probe;
  return {probe,context,node,setNow:value=>now=value};
}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}

test('a transient waiting event with playable audio never interrupts input',async()=>{
  const {probe}=fixture();probe.audio.readyState=3;probe.audio.ahead=4;
  probe.pointer.set(-2,{id:-2,active:true});
  probe.streamSession={wait(){throw Error('must not wait again');}};
  await probe.recoverStreamBuffer();
  assert.equal(probe.pointer.size,1);assert.equal(probe.cancelledLoops,undefined);
  assert.equal(probe.audio.playCalls,0);assert.equal(probe.streamBuffering,false);
});

test('two held fingers survive real buffering; movement and a real lift remain independent',async()=>{
  const {probe,node,setNow}=fixture(),ready=deferred();
  probe.streamSession={wait:()=>ready.promise};
  const first={identifier:1,clientX:100,clientY:200},second={identifier:2,clientX:300,clientY:200};
  probe.touchStart({changedTouches:[first,second],touches:[first,second],timeStamp:1000});
  const hold1={n:{holdPointer:-2,releaseAt:Infinity}},hold2={n:{holdPointer:-3,releaseAt:Infinity}};
  probe.activeHolds.add(hold1);probe.activeHolds.add(hold2);
  const pending=probe.recoverStreamBuffer();await new Promise(setImmediate);
  assert.equal(probe.streamBuffering,true);assert.equal(probe.pointer.size,2);
  assert.equal(node('#streamBufferStatus').classList.contains('hidden'),false);
  const moved={...second,clientX:420};setNow(1200);
  probe.touchMove({changedTouches:[moved],touches:[first,moved],timeStamp:1200});
  assert.equal(probe.pointer.get(-3).x,420);
  probe.touchEnd({changedTouches:[first],touches:[moved],timeStamp:1300});
  assert.equal(probe.pointer.has(-2),false);assert.equal(probe.pointer.has(-3),true);
  assert.equal(hold2.n.releaseAt,Infinity);
  setNow(6000);ready.resolve();await pending;
  assert.equal(probe.audio.playCalls,1);assert.equal(probe.audio.currentTime,40);
  assert.equal(probe.pointer.get(-3).active,true);assert.equal(probe.pointer.get(-3).lastT,6000);
  assert.equal(hold1.n.releaseAt,6,'a real lift during buffering gets normal release grace after recovery');
  assert.equal(hold2.n.releaseAt,Infinity);assert.equal(probe.streamBuffering,false);
  assert.equal(node('#streamBufferStatus').classList.contains('hidden'),true);
  assert.equal(probe.scheduledLoops,1);
});

test('buffering freezes judgement but still permits contact tracking',()=>{
  const {probe}=fixture();probe.streamBuffering=true;
  assert.equal(probe.findCandidateMask(2,100,200),null);
  probe.touchStart({changedTouches:[{identifier:7,clientX:100,clientY:200}],touches:[{identifier:7,clientX:100,clientY:200}],timeStamp:1000});
  assert.equal(probe.pointer.get(-8).active,true);
});

test('PJSK and keyboard input cannot score extra notes at a frozen music position',()=>{
  const {probe,context}=fixture();probe.chart.kind='pjsk';probe.streamBuffering=true;
  // Calling the real methods must return before touching any judgement helpers.
  context.Engine.prototype.tryTap.call(probe,-2,100,200,40);
  assert.equal(context.Engine.prototype.tryArmDrag.call(probe,-2,100,200,40),false);
  assert.equal(context.Engine.prototype.tryFlick.call(probe,-2,100,200,40),false);
  context.Engine.prototype.keyboardDown.call(probe,'KeyD');
  context.Engine.prototype.scheduleLoop.call(probe);
});

test('manual pause invalidates pending network recovery and cannot autoplay later',async()=>{
  const {probe}=fixture(),ready=deferred();
  probe.streamSession={wait:()=>ready.promise};
  const pending=probe.recoverStreamBuffer();await new Promise(setImmediate);
  probe.paused=true;probe.transitionToken++;
  ready.resolve();await pending;
  assert.equal(probe.audio.playCalls,0);assert.equal(probe.scheduledLoops,undefined);
});

test('duplicate waiting events do not start concurrent recovery loops',async()=>{
  const {probe}=fixture(),ready=deferred();let waits=0;
  probe.streamSession={wait:()=>{waits++;return ready.promise;}};
  const first=probe.recoverStreamBuffer(),second=probe.recoverStreamBuffer();
  await new Promise(setImmediate);assert.equal(waits,1);ready.resolve();await Promise.all([first,second]);
  assert.equal(probe.audio.playCalls,1);
});

test('background remount updates src without blanking the current image or forcing layout',()=>{
  const {probe,node}=fixture();const image=node('#gameBgImage');let src='old',clears=0;
  image.getAttribute=()=>src;image.setAttribute=(_name,value)=>src=value;image.removeAttribute=()=>clears++;
  Object.defineProperty(image,'offsetWidth',{get(){throw Error('forced layout');}});
  probe.setBackgroundElementSource('new',false,'baked',true);
  assert.equal(src,'new');assert.equal(clears,0);
});

test('buffer duration does not consume existing Hold release or cancellation grace',()=>{
  const {probe}=fixture();
  probe.activeHolds.add({n:{releaseAt:.9}});
  probe.pointer.set(-2,{x:10,y:20,ghostUntil:1.3,speed:200});
  probe.rebaseBufferedInput(1000,6000);
  assert.equal([...probe.activeHolds][0].n.releaseAt,5.9);
  assert.equal(probe.pointer.get(-2).ghostUntil,6.3);
  assert.equal(probe.pointer.get(-2).speed,0);
});
