/* No DOM work or audio work: this worker lives only for a chart load. */
'use strict';
importScripts('./chart-codec.js');
self.onmessage=async({data})=>{
  try{
    importScripts('./vendor/lzma.js');
    const bytes=await new Promise((resolve,reject)=>LZMA.decompress(data.bytes,(result,error)=>{
      if(error)return reject(error);
      resolve(typeof result==='string'?new TextEncoder().encode(result):Uint8Array.from(result));
    }));
    if(bytes.length!==data.expectedSize)throw Error('内置谱面解压长度不一致');
    const packed=bytes[0]===80&&bytes[1]===57&&bytes[2]===67&&bytes[3]===49;
    const output=packed?new TextEncoder().encode(JSON.stringify(PhiChartCodec.decodePacked(bytes))):bytes;
    self.postMessage({ok:true,bytes:output},[output.buffer]);
  }catch(error){self.postMessage({ok:false,error:error?.message||String(error)});}
};
