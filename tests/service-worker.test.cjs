const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function runtime(network=async()=>new Response('network')){
  const stores=new Map(),handlers={};let calls=0,keysCalls=0;
  const name='tycphigros-4.0.1.2-stability-2',codeName='tycphigros-app-performance-3';
  const caches={async keys(){return [...stores.keys()];},async delete(key){return stores.delete(key);},async open(key){
    if(!stores.has(key))stores.set(key,new Map());const entries=stores.get(key);
    const keyFor=req=>typeof req==='string'?req:req.url;
    return {async match(req){return entries.get(keyFor(req))?.clone();},async put(req,res){entries.set(keyFor(req),res);},async keys(){keysCalls++;return [...entries.keys()];},async delete(req){return entries.delete(keyFor(req));}};
  }};
  const context=vm.createContext({URL,Response,Headers,AbortController,setTimeout,clearTimeout,console,caches,Date,
    self:{location:{origin:'https://example.test'},addEventListener:(name,fn)=>handlers[name]=fn,clients:{claim(){}},skipWaiting(){}},
    fetch:async(req,opts)=>{calls++;return network(req,opts);}});
  vm.runInContext(fs.readFileSync('sw.js','utf8'),context);
  const req=(path,{range,mode='same-origin'}={})=>({method:'GET',url:'https://example.test'+path,mode,headers:new Headers(range?{Range:range}:{})});
  async function fetch(request){let response;const pending=[];handlers.fetch({request,respondWith:p=>response=p,waitUntil:p=>pending.push(p)});const result=await response;await Promise.all(pending);return result;}
  return {fetch,req,caches,name,codeName,get calls(){return calls;},get keysCalls(){return keysCalls;}};
}
test('repeat code loads use the current build cache and avoid another network trip',async()=>{
  const r=runtime();await r.fetch(r.req('/phigros/js/app.js?v=3'));await r.fetch(r.req('/phigros/js/app.js?v=3'));
  assert.equal(r.calls,1);
});
test('media from the previous release remains available in the shared media cache',async()=>{
  const r=runtime();const cache=await r.caches.open(r.name);
  await cache.put(r.req('/phigros/assets/cover.jpg'),new Response('cover'));
  assert.equal(await (await r.fetch(r.req('/phigros/assets/cover.jpg'))).text(),'cover');assert.equal(r.calls,0);
});
test('native audio ranges retain exact byte offsets including suffixes',async()=>{
  const r=runtime(),cache=await r.caches.open(r.name),path='/phigros/assets/song.m4a';
  await cache.put(r.req(path),new Response('0123456789',{headers:{'Content-Type':'audio/mp4','Content-Length':'10'}}));
  const middle=await r.fetch(r.req(path,{range:'bytes=2-5'}));
  assert.equal(middle.status,206);assert.equal(middle.headers.get('Content-Range'),'bytes 2-5/10');assert.equal(await middle.text(),'2345');
  assert.equal(await (await r.fetch(r.req(path,{range:'bytes=-3'}))).text(),'789');
  assert.equal((await r.fetch(r.req(path,{range:'bytes=12-'}))).status,416);assert.equal(r.calls,0);
});
test('network partial responses never poison the full audio cache',async()=>{
  const r=runtime(async()=>new Response('01',{status:206,headers:{'Content-Range':'bytes 0-1/10'}}));
  await r.fetch(r.req('/phigros/assets/song.m4a',{range:'bytes=0-1'}));
  const cache=await r.caches.open(r.name);assert.equal(await cache.match(r.req('/phigros/assets/song.m4a')),undefined);
});
test('navigation checks the network but falls back to the cached page during an outage',async()=>{
  let offline=false;const r=runtime(async()=>{if(offline)throw Error('offline');return new Response('page');});
  const req=r.req('/phigros/',{mode:'navigate'});await r.fetch(req);offline=true;
  assert.equal(await (await r.fetch(req)).text(),'page');assert.equal(r.calls,2);
});
test('a batch of skin requests runs one cache maintenance sweep',async()=>{
  const r=runtime();await Promise.all([1,2,3,4].map(i=>r.fetch(r.req('/phigros/assets/skin/'+i+'.webp'))));
  assert.equal(r.keysCalls,1);
});
