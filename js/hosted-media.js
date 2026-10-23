/* Same-origin progressive media. Full originals remain the source for exports. */
(() => {
  'use strict';
  const manifest = globalThis.PhiHostedManifest;
  const downloads = new Map();
  let cachedBytes = 0;
  const MAX_CACHE = 12 * 1024 * 1024;
  function url(path) {
    const value = new URL(path, document.baseURI);
    if (value.origin !== location.origin || !/^https?:$/.test(value.protocol)) throw Error('资源必须来自本站');
    return value.href;
  }
  function abortable(promise,signal){
    if(!signal)return promise;
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(new DOMException('资源读取已取消','AbortError'));
      if(signal.aborted)return abort();
      signal.addEventListener('abort',abort,{once:true});
      promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
  }
  async function bytes(path, { onProgress, priority = 'auto', signal } = {}) {
    if(signal?.aborted)throw new DOMException('资源读取已取消','AbortError');
    const href = url(path);
    if (downloads.has(href)) return abortable(downloads.get(href).promise,signal);
    const item = { size: 0, promise: null };
    item.promise = (async () => {
      const controller = new AbortController();
      const abort=()=>controller.abort();
      signal?.addEventListener('abort',abort,{once:true});
      let timeout;
      const renew = () => { clearTimeout(timeout); timeout = setTimeout(() => controller.abort(), 45000); };
      renew();
      try {
        const response = await fetch(href, { credentials: 'same-origin', signal: controller.signal, priority });
        if (!response.ok) throw Error(`资源加载失败（${response.status}）：${path}`);
        const total = Number(response.headers.get('content-length')) || 0;
        let result;
        if (response.body?.getReader) {
          const reader = response.body.getReader(), chunks = [];
          let received = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            chunks.push(part.value); received += part.value.byteLength; renew();
            onProgress?.(received, total);
          }
          result = new Uint8Array(received);
          let offset = 0;
          for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
        } else result = new Uint8Array(await response.arrayBuffer());
        item.size = result.byteLength; cachedBytes += item.size;
        for (const [key, old] of downloads) {
          if (cachedBytes <= MAX_CACHE) break;
          if (old !== item && old.size) { cachedBytes -= old.size; downloads.delete(key); }
        }
        return result;
      } catch (error) {
        downloads.delete(href);
        if(signal?.aborted)throw new DOMException('资源读取已取消','AbortError');
        if (controller.signal.aborted) throw Error('网络暂时没有响应，请返回选歌后重试');
        throw error;
      } finally { clearTimeout(timeout);signal?.removeEventListener('abort',abort); }
    })();
    downloads.set(href, item);
    return abortable(item.promise,signal);
  }
  async function artwork(asset, { onStage, active = () => true, maxStage = 2, fromStage = 0, signal } = {}) {
    const spec = manifest.artwork[asset];
    if (!spec) return null;
    let last = null;
    for (let stage = fromStage; stage <= Math.min(maxStage, spec.stages.length - 1); stage++) {
      if (!active()) break;
      try {
        const data = await bytes(spec.stages[stage].url, { priority: stage === 0 ? 'high' : 'low',signal });
        const blob = new Blob([data], { type: 'image/jpeg' });
        if (!active()) break;
        last = blob;
        await onStage?.(blob, stage);
      } catch (error) {
        if(error.name==='AbortError')break;
        // A failed clear image must never hide the already visible small image.
        if (stage === 0) throw error;
        console.warn('[Artwork]', error.message);
      }
    }
    return last;
  }
  function bufferedAhead(audio, at = Number(audio.currentTime) || 0) {
    for (let i = 0; i < audio.buffered.length; i++) {
      if (audio.buffered.start(i) <= at + .15 && audio.buffered.end(i) > at)
        return Math.max(0, audio.buffered.end(i) - at);
    }
    return 0;
  }
  function decodeChart(packed,expectedSize){
    return new Promise((resolve,reject)=>{
      let worker,timer;
      const finish=(error,bytes)=>{clearTimeout(timer);worker?.terminate();error?reject(error):resolve(bytes);};
      try{
        worker=new Worker(url('./js/chart-decode-worker.js'));
        worker.onmessage=({data})=>finish(data.ok?null:Error(data.error),data.bytes);
        worker.onerror=()=>finish(Object.assign(Error('谱面后台线程不可用'),{name:'WorkerUnavailableError'}));
        timer=setTimeout(()=>finish(Error('谱面后台解码超时')),30000);
        // Transfer a copy: the compressed download cache must remain reusable.
        const bytes=packed.slice();worker.postMessage({bytes,expectedSize},[bytes.buffer]);
      }catch(error){finish(Object.assign(Error(error?.message||'谱面后台线程不可用'),{name:'WorkerUnavailableError'}));}
    });
  }
  function bufferTarget(duration, downloadRate, elapsed, minimum = 6) {
    if(globalThis.PhiPerformance)return PhiPerformance.startupBuffer(duration,downloadRate,elapsed,minimum);
    if (elapsed < 1.2 || !(downloadRate > 0)) return Math.min(duration, minimum);
    if (downloadRate < 1.1) return Math.min(duration, Math.max(minimum, duration * Math.max(0, 1 - downloadRate) + 10));
    return Math.min(duration, downloadRate >= 2 ? minimum : Math.max(minimum, 12));
  }
  class Stream {
    constructor(audio, spec, onProgress) {
      this.audio = audio; this.spec = spec; this.onProgress = onProgress;
      this.controller = new AbortController(); this.started = performance.now();
      this.lastBufferEnd=0;this.downloadRate=0;this.initialReady=false;
      audio.pause(); audio.loop = false; audio.muted = false; audio.preload = 'auto';
      audio.setAttribute('playsinline', '');
      audio.src = url(spec.url); audio.load();
    }
    snapshot(minimum = 6) {
      const at = Number(this.audio.currentTime) || 0;
      const duration = Number.isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : this.spec.duration;
      const ahead = bufferedAhead(this.audio, at), elapsed = Math.max(.01, (performance.now() - this.started) / 1000);
      this.lastBufferEnd=Math.max(this.lastBufferEnd,ahead+at);
      // Initial browser bursts are not sustained throughput. Include quiet time
      // in the estimate, otherwise a fast first chunk hides an under-speed link.
      const rate=this.downloadRate=this.lastBufferEnd/elapsed;
      const remaining = Math.max(0, duration - at);
      const target = this.initialReady?Math.min(remaining,minimum):bufferTarget(remaining, rate, elapsed, minimum);
      return { ahead, target, duration, rate, complete: ahead >= remaining - .1,
        ready: this.audio.readyState >= 3 && (ahead >= target || ahead >= remaining - .1) };
    }
    wait(minimum = 6, {signal: externalSignal} = {}) {
      const audio = this.audio, signal = this.controller.signal;
      return new Promise((resolve, reject) => {
        let timer, lastAhead = -1, lastProgress = performance.now();
        const finish = error => {
          clearInterval(timer);
          for (const event of ['progress', 'loadedmetadata', 'canplay', 'error']) audio.removeEventListener(event, check);
          signal.removeEventListener('abort', abort);
          externalSignal?.removeEventListener('abort',abort);
          error ? reject(error) : resolve(audio);
        };
        const abort = () => finish(new DOMException('已返回选歌', 'AbortError'));
        const check = () => {
          if (signal.aborted||externalSignal?.aborted) return abort();
          if (audio.error) return finish(Error('音乐加载失败，请返回选歌重试'));
          const state = this.snapshot(minimum);
          if (state.ahead > lastAhead + .1) { lastProgress = performance.now(); lastAhead = state.ahead; }
          this.onProgress?.(state);
          if (state.ready) {this.initialReady=true;return finish();}
          if (performance.now() - lastProgress > 45000) finish(Error('网络暂时没有响应，请返回选歌重试'));
        };
        for (const event of ['progress', 'loadedmetadata', 'canplay', 'error']) audio.addEventListener(event, check);
        signal.addEventListener('abort', abort, { once: true });
        externalSignal?.addEventListener('abort',abort,{once:true});
        timer = setInterval(check, 120); check();
      });
    }
    destroy() { this.controller.abort(); }
  }
  globalThis.PhiHostedMedia = Object.freeze({ manifest, url, bytes, artwork, bufferedAhead, bufferTarget, decodeChart, Stream });
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}), { once: true });
  }
})();
