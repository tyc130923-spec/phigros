const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {performance} = require('node:perf_hooks');

function runtime(overrides = {}) {
  const context = vm.createContext({
    console, URL, URLSearchParams, Blob, Response, ReadableStream, Uint8Array, DOMException, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval, performance,
    document: {baseURI: 'https://example.test/phigros/'}, location: {origin:'https://example.test', protocol:'https:'},
    navigator: {}, window:{addEventListener(){}},
    PhiHostedManifest: {audio:{}, artwork:{}},
    fetch: async () => new Response('asset'), ...overrides
  });
  vm.runInContext(fs.readFileSync('js/performance-policy.js','utf8'), context);
  vm.runInContext(fs.readFileSync('js/hosted-media.js','utf8'), context);
  return context;
}
class FakeAudio extends EventTarget {
  constructor(ahead=0){super();this.ahead=ahead;this.currentTime=0;this.duration=160;this.readyState=3;
    this.buffered={get length(){return 1;},start:()=>0,end:()=>this.ahead};}
  pause(){this.paused=true;}
  setAttribute(){}
  getAttribute(name){return name==='src'?this.src:null;}
  removeAttribute(name){if(name==='src')this.src='';}
  load(){}
}

test('begins after a short buffer, before the rest of the song arrives', async()=>{
  const {PhiHostedMedia:media}=runtime();const audio=new FakeAudio(13);
  const stream=new media.Stream(audio,{url:'./music.m4a',duration:160});
  await stream.wait();assert(audio.ahead<audio.duration);stream.destroy();
});
test('waits for audio readiness and then resolves as more audio arrives',async()=>{
  const {PhiHostedMedia:media}=runtime();const audio=new FakeAudio(2),stream=new media.Stream(audio,{url:'./music.m4a',duration:160});
  let done=false;const pending=stream.wait().then(()=>done=true);
  await Promise.resolve();assert.equal(done,false);
  audio.ahead=12;audio.dispatchEvent(new Event('progress'));await pending;assert.equal(done,true);stream.destroy();
});
test('returning to the library aborts a pending wait without hanging',async()=>{
  const {PhiHostedMedia:media}=runtime();const stream=new media.Stream(new FakeAudio(0),{url:'./music.m4a',duration:160});
  const pending=stream.wait();stream.destroy();await assert.rejects(pending,{name:'AbortError'});
});
test('under-speed links require enough headroom to cover their measured deficit',()=>{
  const {PhiHostedMedia:media}=runtime();
  assert.equal(media.bufferTarget(160,.5,8),90);
  assert.equal(media.bufferTarget(160,3,8),6);
  assert.equal(media.bufferTarget(5,.5,8),5);
});
test('a fully buffered short tail can resume immediately',async()=>{
  const {PhiHostedMedia:media}=runtime();const audio=new FakeAudio(160);audio.currentTime=158;
  const stream=new media.Stream(audio,{url:'./music.m4a',duration:160});await stream.wait(12);stream.destroy();
});
test('failed fetches can be retried and never poison the cache',async()=>{
  let calls=0;const {PhiHostedMedia:media}=runtime({fetch:async()=>{calls++;return calls===1?new Response('',{status:503}):new Response('ok');}});
  await assert.rejects(media.bytes('./art.jpg'));assert.equal(Buffer.from(await media.bytes('./art.jpg')).toString(),'ok');assert.equal(calls,2);
});
test('progressive artwork preserves the small image if the clear image fails',async()=>{
  const observed=[];const {PhiHostedMedia:media}=runtime({
    PhiHostedManifest:{artwork:{cover:{stages:[{url:'./tiny.jpg'},{url:'./medium.jpg'},{url:'./clear.jpg'}]}}},
    fetch:async href=>href.endsWith('clear.jpg')?new Response('',{status:503}):new Response('image')
  });
  const last=await media.artwork('cover',{onStage:async(blob,stage)=>observed.push(stage)});
  assert.deepEqual(observed,[0,1]);assert.equal(last.size,5);
});
test('blocks cross-origin resource paths',async()=>{
  const {PhiHostedMedia:media}=runtime();await assert.rejects(media.bytes('https://elsewhere.test/music'));
});

test('a browser denying workers reports a compatibility fallback without mutating its DOMException',async()=>{
  class BlockedWorker{constructor(){throw new DOMException('blocked','SecurityError');}}
  const {PhiHostedMedia:media}=runtime({Worker:BlockedWorker});
  await assert.rejects(media.decodeChart(new Uint8Array([1,2]),2),{name:'WorkerUnavailableError'});
});
test('chart loading transfers a copy and terminates its worker after receiving the result',async()=>{
  let transfer,terminated=false;
  class DecoderWorker{
    postMessage(data){transfer=data.bytes;setTimeout(()=>this.onmessage({data:{ok:true,bytes:new Uint8Array([123,125])}}),0);}
    terminate(){terminated=true;}
  }
  const {PhiHostedMedia:media}=runtime({Worker:DecoderWorker}),packed=new Uint8Array([1,2,3]);
  const result=await media.decodeChart(packed,3);
  assert.notEqual(transfer,packed);assert.deepEqual([...packed],[1,2,3]);assert.deepEqual([...result],[123,125]);assert.equal(terminated,true);
});

test('a caller can cancel a recovery wait without destroying the stream',async()=>{
  const {PhiHostedMedia:media}=runtime(),stream=new media.Stream(new FakeAudio(0),{url:'./music.m4a',duration:160});
  const controller=new AbortController(),pending=stream.wait(12,{signal:controller.signal});
  controller.abort();await assert.rejects(pending,{name:'AbortError'});
  assert.equal(stream.controller.signal.aborted,false);stream.destroy();
});
test('a fast first chunk followed by a slow link lowers the measured download rate',()=>{
  let now=0;const {PhiHostedMedia:media}=runtime({performance:{now:()=>now}});
  const audio=new FakeAudio(4),stream=new media.Stream(audio,{url:'./music.m4a',duration:160});
  now=100;stream.snapshot(12);now=10000;
  const state=stream.snapshot(12);
  assert.equal(state.rate,.4);assert(state.target>90);stream.destroy();
});
test('an artwork deadline aborts its fetch instead of blocking song startup',async()=>{
  let aborted=false;
  const {PhiHostedMedia:media}=runtime({fetch:(_url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted=true;reject(new DOMException('cancel','AbortError'));});
  }),PhiHostedManifest:{artwork:{cover:{stages:[{url:'./tiny.jpg'},{url:'./medium.jpg'}]}}}});
  const controller=new AbortController();
  const pending=media.artwork('cover',{fromStage:1,signal:controller.signal});
  controller.abort();await pending;assert.equal(aborted,true);
});

test('opening cues follow the music clock, remain clear after looping, and stop on exit',async()=>{
  let now=0,frame;const styles=new Map();
  const home={clientWidth:682,clientHeight:512,dataset:{},style:{setProperty:(k,v)=>styles.set(k,v)},appendChild(){}};
  const ctx=new Proxy({}, {get:()=>()=>{},set:()=>true});
  const elements={refHome:home,openingParticles:{getContext:()=>ctx},openingSound:{}};
  class AudioMock extends FakeAudio{constructor(src){super();this.src=src;this.readyState=4;this.currentTime=0;}play(){this.paused=false;return Promise.resolve();}}
  const context=vm.createContext({console,URL,URLSearchParams,Audio:AudioMock,performance:{now:()=>now},
    PhiHostedManifest:{opening:{audio:'./theme.m4a',warningAt:3.4,titleAt:8,titleSettledAt:8.9}},
    document:{baseURI:'https://example.test/',getElementById:id=>elements[id],addEventListener(){}},
    location:{search:''},window:{addEventListener(){}},matchMedia:()=>({matches:false}),
    innerWidth:682,innerHeight:512,devicePixelRatio:1,requestAnimationFrame:f=>(frame=f,1),cancelAnimationFrame:()=>frame=null});
  vm.runInContext(fs.readFileSync('js/opening.js','utf8'),context);await Promise.resolve();
  const opening=context.PhiOpening;
  now=90000;frame();assert.equal(home.dataset.stage,'studio','wall clock must not move a stalled music clock');
  opening.audio.currentTime=3.4;frame();assert.equal(home.dataset.stage,'warning');
  opening.audio.currentTime=8.9;frame();assert.equal(home.dataset.stage,'title');assert.equal(styles.get('--opening-blur'),'0px');
  opening.audio.currentTime=.1;frame();assert.equal(home.dataset.stage,'title');assert.equal(styles.get('--opening-blur'),'0px');
  opening.stop();assert.equal(opening.audio.paused,true);assert.equal(frame,null);
  assert.equal(opening.audio.src,'','leaving the title must cancel its competing media request');
  assert.equal(opening.audio.preload,'none');
  opening.show(false);await Promise.resolve();frame();assert.equal(home.dataset.stage,'title');assert(opening.audio.src);
  opening.stop();
});
