/* Fixed per-viewport budgets: input coordinates and chart content stay logical. */
(() => {
  'use strict';
  function renderDpr(width,height,nativeDpr,{cores=8,memory=8,heavy=false}={}){
    const area=Math.max(1,width*height),native=Math.max(1,Number(nativeDpr)||1);
    const constrained=cores<=4||memory<=4;
    const budget=constrained?2000000:heavy?3000000:4000000;
    return Math.min(native,2,Math.max(.5,Math.sqrt(budget/area)));
  }
  function startupBuffer(duration,rate,elapsed,minimum=6){
    const remaining=Math.max(0,Number(duration)||0),floor=Math.min(remaining,minimum);
    if(elapsed<1.5||!(rate>0))return Math.min(remaining,Math.max(floor,8));
    // Match download time to the unbuffered tail instead of demanding a fixed
    // 12 seconds even on fast links; retain deficit coverage on slow links.
    if(rate<1.15)return Math.min(remaining,Math.max(floor,remaining*Math.max(0,1-rate)+10));
    return Math.min(remaining,rate>=2?floor:Math.max(floor,10));
  }
  class ResourceCache{
    constructor(maxBytes,maxEntries){this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.entries=new Map();this.weights=new Map();this.bytes=0;}
    get size(){return this.entries.size;}
    has(key){return this.entries.has(key);}
    get(key){if(!this.entries.has(key))return;const value=this.entries.get(key);this.entries.delete(key);this.entries.set(key,value);return value;}
    set(key,value){this.delete(key);this.entries.set(key,value);this.trim();return this;}
    setWeight(key,size){if(!this.entries.has(key))return;this.bytes-=this.weights.get(key)||0;this.weights.set(key,Math.max(0,Number(size)||0));this.bytes+=this.weights.get(key);this.trim();}
    delete(key){this.bytes-=this.weights.get(key)||0;this.weights.delete(key);return this.entries.delete(key);}
    trim(){while(this.entries.size&&(this.bytes>this.maxBytes||this.entries.size>this.maxEntries))this.delete(this.entries.keys().next().value);}
  }
  globalThis.PhiPerformance=Object.freeze({renderDpr,startupBuffer,ResourceCache});
})();
