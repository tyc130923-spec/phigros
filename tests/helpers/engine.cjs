const fs=require('node:fs');
const vm=require('node:vm');
// Exercise the shipped Engine methods without initializing the app or a GPU.
const source=fs.readFileSync('js/app.js','utf8');
const engineSource=source.slice(source.indexOf('  class Engine {'),source.indexOf('  let resultArtworkURL'));
const inputConstants=source.slice(source.indexOf('  const PERFECT ='),source.indexOf('  // Official-like global Note depth'));
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
    performance:{now:()=>now,timeOrigin:1700000000000},document:{hidden:false},Element:ElementMock,
    $:node,engine:null,sleep:async()=>{},withTimeout:p=>p,
    PhiHostedMedia:{bufferedAhead:audio=>audio.ahead},
    clamp:(v,a,b)=>Math.max(a,Math.min(b,v)),touchSensitivity:1,
    FLICK_SPEED:138,FLICK_TRAVEL:5.5,FLICK_REARM_MS:58,FLICK_REARM_TRAVEL_GAIN:.42,
    MULTITOUCH_CANCEL_GRACE:.38,POINTER_DUPLICATE_EPS_MS:.08,POINTER_DUPLICATE_EPS_PX:.04,
    Diagnostics:{warn(){}},toast:()=>{},...overrides});
  vm.runInContext(inputConstants+'\n'+engineSource+'\nglobalThis.Engine=Engine;',context);
  const probe=Object.create(context.Engine.prototype);
  Object.assign(probe,{running:true,paused:false,starting:false,resumePending:false,autoplay:false,
    transitionToken:1,useNativeTouchInput:true,pointer:new Map(),pointerPool:[],activeHolds:new Set(),
    nativeTouchBlocked:new Set(),nativeTouchLiveIds:new Set(),nativeTouchChangedIds:new Set(),
    nativePointerLinks:new Map(),canvas:{},singlePointerEvent:[null],
    inputStats:{pointerDown:0,touchStart:0,edges:0,accepted:0,noCandidate:0,blocked:0,earlyGuard:0,bridges:0,recovered:0,maxDispatchMs:0},
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

module.exports={fixture};
