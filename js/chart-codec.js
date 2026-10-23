/* Lossless P9C1 codec, shared by the loading worker and compatibility fallback. */
(()=>{
  'use strict';
  function decodePackedNativeChart(bytes){
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),decoder=new TextDecoder(),keys=[],schemas=[],refs=[];let pos=4;
    if(bytes[0]!==80||bytes[1]!==57||bytes[2]!==67||bytes[3]!==49)throw new Error('内置谱面编码无效');
    const uint=()=>{let n=0,m=1,b;do{if(pos>=bytes.length)throw new Error('内置谱面数据截断');b=bytes[pos++];n+=(b&127)*m;m*=128;}while(b&128);return n;};
    const biguint=()=>{let n=0n,shift=0n,b;do{if(pos>=bytes.length)throw new Error('内置谱面数据截断');b=bytes[pos++];n|=BigInt(b&127)<<shift;shift+=7n;}while(b&128);return n;};
    const signed=()=>{const n=biguint();return (n&1n)?-(n+1n)/2n:n/2n;};
    const text=()=>{const n=uint();if(pos+n>bytes.length)throw new Error('内置谱面文本截断');const value=decoder.decode(bytes.subarray(pos,pos+n));pos+=n;return value;};
    const key=()=>{const id=uint();if(id&1){const value=text();keys[id>>>1]=value;return value;}return keys[id>>>1];};
    const schema=()=>{const id=uint();if(id&1){const n=uint(),fields=Array.from({length:n},key);schemas[id>>>1]=fields;return fields;}return schemas[id>>>1];};
    const value=()=>{const type=bytes[pos++];switch(type){
      case 10:return refs[uint()];case 11:{const id=uint(),v=value();refs[id]=v;return v;}
      case 0:return null;case 1:return false;case 2:return true;case 3:return Number(signed());case 4:{const v=view.getFloat64(pos,true);pos+=8;return v;}case 5:return text();
      case 6:{const n=uint(),out=new Array(n);for(let i=0;i<n;i++)out[i]=value();return out;}
      case 7:{const fields=schema(),out={};for(const f of fields)out[f]=value();return out;}
      case 8:{const n=uint(),fields=schema(),out=Array.from({length:n},()=>({}));for(const f of fields){const column=value();if(column.length!==n)throw new Error('内置谱面列长度不一致');for(let i=0;i<n;i++)out[i][f]=column[i];}return out;}
      case 9:{const n=uint(),out=new Array(n);for(let start=0;start<n;start+=128){const scale=uint();let prev=0n,delta=0n;for(let i=start;i<Math.min(n,start+128);i++){delta+=signed();prev+=delta;out[i]=Number(prev.toString()+'e-'+scale);}}return out;}
      default:throw new Error('内置谱面编码类型无效：'+type);
    }};
    const result=value();if(pos!==bytes.length)throw new Error('内置谱面尾部校验失败');return result;
  }
  globalThis.PhiChartCodec=Object.freeze({decodePacked:decodePackedNativeChart});
})();
