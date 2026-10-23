/* Cache only successful same-origin resources; preserve native audio Range I/O. */
'use strict';
const CACHE='tycphigros-4.0.1.2-media-1';
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if(key.startsWith('tycphigros-')&&key!==CACHE)await caches.delete(key);
  await self.clients.claim();
})()));
async function ranged(response,range){
  const data=await response.arrayBuffer(),match=/^bytes=(\d*)-(\d*)$/.exec(range);
  if(!match)return null;
  let start=match[1]?Number(match[1]):Math.max(0,data.byteLength-Number(match[2]));
  let end=match[1]?(match[2]?Math.min(data.byteLength-1,Number(match[2])):data.byteLength-1):data.byteLength-1;
  if(start>end||start>=data.byteLength)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${data.byteLength}`}});
  const headers=new Headers(response.headers);
  headers.delete('Content-Encoding');headers.set('Content-Range',`bytes ${start}-${end}/${data.byteLength}`);
  headers.set('Content-Length',String(end-start+1));headers.set('Accept-Ranges','bytes');
  return new Response(data.slice(start,end+1),{status:206,statusText:'Partial Content',headers});
}
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),range=request.headers.get('Range');
    if(range){
      const full=await cache.match(request.url);
      if(full?.status===200){const result=await ranged(full,range);if(result)return result;}
      return fetch(request);
    }
    const cached=await cache.match(request);
    const fresh=async()=>{
      const response=await fetch(request);
      const length=Number(response.headers.get('Content-Length'));
      if(response.status===200&&response.type!=='opaque'&&(!length||length<=8*1024*1024)){
        const copy=response.clone();
        event.waitUntil((async()=>{
          try{
            await cache.put(request,copy);
            const keys=await cache.keys();
            for(const key of keys.slice(0,Math.max(0,keys.length-80)))await cache.delete(key);
          }catch{}
        })());
      }
      return response;
    };
    if(request.mode==='navigate'||/\.(?:js|css)$/.test(url.pathname)){
      try{return await fresh();}catch(error){if(cached)return cached;throw error;}
    }
    if(cached)return cached;
    return fresh();
  })());
});
