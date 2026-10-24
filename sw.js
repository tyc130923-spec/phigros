/* Code is versioned separately from unchanged media. Never cache partial audio. */
'use strict';
const APP_CACHE='tycphigros-app-input-6';
// Reuse the existing media store across this code-only release.
const MEDIA_CACHE='tycphigros-4.0.1.2-stability-2';
let nextMaintenance=0;
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())
    if(key.startsWith('tycphigros-')&&key!==APP_CACHE&&key!==MEDIA_CACHE)await caches.delete(key);
  await self.clients.claim();
})()));
async function ranged(response,range){
  const data=await response.blob(),match=/^bytes=(\d*)-(\d*)$/.exec(range);
  if(!match)return null;
  const start=match[1]?Number(match[1]):Math.max(0,data.size-Number(match[2]));
  const end=match[1]?(match[2]?Math.min(data.size-1,Number(match[2])):data.size-1):data.size-1;
  if(start>end||start>=data.size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${data.size}`}});
  const headers=new Headers(response.headers);
  headers.delete('Content-Encoding');headers.set('Content-Range',`bytes ${start}-${end}/${data.size}`);
  headers.set('Content-Length',String(end-start+1));headers.set('Accept-Ranges','bytes');
  return new Response(data.slice(start,end+1),{status:206,statusText:'Partial Content',headers});
}
async function save(cache,request,response){
  try{
    await cache.put(request,response);
    if(Date.now()>=nextMaintenance){
      nextMaintenance=Date.now()+60000;
      const keys=await cache.keys();
      for(const key of keys.slice(0,Math.max(0,keys.length-160)))await cache.delete(key);
    }
  }catch{}
}
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  const lifetime={network:Promise.resolve()};
  const response=(async()=>{
    const media=/\/assets\//.test(url.pathname),cache=await caches.open(media?MEDIA_CACHE:APP_CACHE);
    const range=request.headers.get('Range');
    if(range){
      const full=await cache.match(request.url);
      if(full?.status===200){const result=await ranged(full,range);if(result)return result;}
      return fetch(request);
    }
    const cached=await cache.match(request);
    if(cached&&request.mode!=='navigate')return cached;
    let stored=Promise.resolve();
    // Revalidate entry/code HTTP responses on a build-cache miss. A fresh HTTP
    // cache entry from the previous deploy must not silently serve old code.
    const network=fetch(request,{cache:media?'default':'no-cache'}).then(response=>{
      const length=Number(response.headers.get('Content-Length'));
      if(response.status===200&&response.type!=='opaque'&&(!length||length<=8*1024*1024))
        stored=save(cache,request,response.clone());
      if(!response.ok&&cached)return cached;
      return response;
    },error=>{if(cached)return cached;throw error;});
    lifetime.network=network.then(()=>stored,()=>{});
    if(cached&&request.mode==='navigate')return new Promise(resolve=>{
      // A slow Chinese-network hop may use the existing entry after 3 seconds,
      // but keep downloading and caching the update for the next visit.
      const timer=setTimeout(()=>resolve(cached),3000);
      network.then(value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);resolve(cached);});
    });
    return network;
  })();
  event.respondWith(response);
  // Register the lifetime extension synchronously, including work which finishes
  // after the cached navigation response has already reached the client.
  event.waitUntil(response.then(()=>lifetime.network).catch(()=>{}));
});
