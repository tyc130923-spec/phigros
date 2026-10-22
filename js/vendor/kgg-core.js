


/* Self-written KGG core — GPL-3.0-or-later. */
/*
 * HTML Audio Converter - KGG offline core
 * KGG implementation is a clean-room JavaScript port based on the algorithmic
 * behavior documented by unlock-music and Kugo-Music-Converter.
 * Use only with audio files you own or are authorized to convert.
 */
(() => {
  'use strict';

  const td = new TextDecoder('utf-8');
  const te = new TextEncoder();
  const KGG_MAGIC = new Uint8Array([0x7c,0xd5,0x32,0xeb,0x86,0x02,0x7f,0x4b,0xa8,0xaf,0xa6,0x8e,0x0f,0xff,0x99,0x14]);
  const DB_MASTER = new Uint8Array([0x1d,0x61,0x31,0x45,0xb2,0x47,0xbf,0x7f,0x3d,0x18,0x96,0x72,0x14,0x4f,0xe4,0xbf]);
  const SQLITE_HEADER = te.encode('SQLite format 3\0');
  const RAW_KEY_PREFIX_V2 = te.encode('QQMusic EncV2,Key:');
  const V2_KEY1 = new Uint8Array([0x33,0x38,0x36,0x5a,0x4a,0x59,0x21,0x40,0x23,0x2a,0x24,0x25,0x5e,0x26,0x29,0x28]);
  const V2_KEY2 = new Uint8Array([0x2a,0x2a,0x23,0x21,0x28,0x23,0x24,0x25,0x26,0x5e,0x61,0x31,0x63,0x5a,0x2c,0x54]);

  function equalAt(a, b, off = 0) {
    if (off + b.length > a.length) return false;
    for (let i = 0; i < b.length; i++) if (a[off + i] !== b[i]) return false;
    return true;
  }
  function le32(a, o) { return (a[o] | a[o+1]<<8 | a[o+2]<<16 | a[o+3]<<24) >>> 0; }
  function be16(a, o) { return (a[o]<<8 | a[o+1]) >>> 0; }
  function be32(a, o) { return ((a[o]<<24) | (a[o+1]<<16) | (a[o+2]<<8) | a[o+3]) >>> 0; }
  function putLe32(a, o, v) { a[o]=v; a[o+1]=v>>>8; a[o+2]=v>>>16; a[o+3]=v>>>24; }
  function putLe16(a, o, v) { a[o]=v; a[o+1]=v>>>8; }
  function concatBytes(...xs) { const n=xs.reduce((s,x)=>s+x.length,0), out=new Uint8Array(n); let p=0; for(const x of xs){out.set(x,p);p+=x.length;} return out; }
  function startsWith(a,b){ return equalAt(a,b,0); }
  function bytesToBase64(bytes){ let s=''; const chunk=0x8000; for(let i=0;i<bytes.length;i+=chunk)s+=String.fromCharCode(...bytes.subarray(i,i+chunk)); return btoa(s); }
  function base64ToBytes(s){ s=s.replace(/\s+/g,''); const raw=atob(s), out=new Uint8Array(raw.length); for(let i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i); return out; }

  // RFC 1321 MD5, returning 16 raw bytes. Used only for Kugou DB page key derivation.
  function md5Bytes(input) {
    const len=input.length, total=((len+9+63)>>6)<<6, data=new Uint8Array(total); data.set(input); data[len]=0x80;
    const bitLen=BigInt(len)*8n; for(let i=0;i<8;i++) data[total-8+i]=Number((bitLen>>BigInt(i*8))&255n);
    let a0=0x67452301|0,b0=0xefcdab89|0,c0=0x98badcfe|0,d0=0x10325476|0;
    const s=[7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
    const K=Array.from({length:64},(_,i)=>(Math.floor(Math.abs(Math.sin(i+1))*4294967296)>>>0));
    for(let off=0;off<total;off+=64){
      const M=new Uint32Array(16); for(let i=0;i<16;i++) M[i]=le32(data,off+i*4);
      let A=a0,B=b0,C=c0,D=d0;
      for(let i=0;i<64;i++){
        let F,g;
        if(i<16){F=(B&C)|((~B)&D);g=i;} else if(i<32){F=(D&B)|((~D)&C);g=(5*i+1)&15;} else if(i<48){F=B^C^D;g=(3*i+5)&15;} else {F=C^(B|(~D));g=(7*i)&15;}
        const x=(A + F + (K[i]|0) + (M[g]|0))|0;
        const r=((x<<s[i]) | (x>>>(32-s[i])))|0;
        const t=D; D=C; C=B; B=(B+r)|0; A=t;
      }
      a0=(a0+A)|0; b0=(b0+B)|0; c0=(c0+C)|0; d0=(d0+D)|0;
    }
    const out=new Uint8Array(16); [a0,b0,c0,d0].forEach((v,i)=>putLe32(out,i*4,v>>>0)); return out;
  }

  async function aesCbcDecryptNoPadding(cipher, keyBytes, iv) {
    if (!crypto?.subtle) throw new Error('当前浏览器没有 Web Crypto，建议使用最新版 Chrome/Edge。');
    if (cipher.length % 16) throw new Error('AES-CBC 数据长度不是 16 的倍数。');
    const key=await crypto.subtle.importKey('raw',keyBytes,{name:'AES-CBC'},false,['encrypt','decrypt']);
    // WebCrypto always applies PKCS#7. Encrypting an empty message with the last
    // ciphertext block as IV creates one valid padding block; appending it lets us
    // recover the original blocks without losing their last bytes.
    const last=cipher.subarray(cipher.length-16);
    const padBlock=new Uint8Array(await crypto.subtle.encrypt({name:'AES-CBC',iv:last},key,new Uint8Array(0)));
    const extended=concatBytes(cipher,padBlock);
    return new Uint8Array(await crypto.subtle.decrypt({name:'AES-CBC',iv},key,extended));
  }

  function nextPageIV(seed){
    const left=Math.imul(seed,0x9ef4)>>>0;
    const right=Math.imul(Math.floor(seed/0xce26),0x7fffff07)>>>0;
    let value=(left-right)>>>0;
    if(value&0x80000000) value=(value+0x7fffff07)>>>0;
    return value;
  }
  function derivePageAESKey(pageNo, master=DB_MASTER){ const b=new Uint8Array(24); b.set(master); putLe32(b,16,pageNo); putLe32(b,20,0x546c4173); return md5Bytes(b); }
  function derivePageAESIV(pageNo){ const b=new Uint8Array(16); let seed=(pageNo+1)>>>0; for(let i=0;i<16;i+=4){seed=nextPageIV(seed);putLe32(b,i,seed);} return md5Bytes(b); }
  async function decryptDBPage(page,pageNo,master=DB_MASTER){ return aesCbcDecryptNoPadding(page,derivePageAESKey(pageNo,master),derivePageAESIV(pageNo)); }

  async function decryptKugouDatabase(input,onProgress=()=>{}){
    const buf=new Uint8Array(input);
    if(startsWith(buf,SQLITE_HEADER)) return buf;
    if(!buf.length || buf.length%0x400) throw new Error(`KGMusicV3.db 大小异常：${buf.length} 字节。`);
    const page1=buf.slice(0,0x400), o10=le32(page1,0x10), o14=le32(page1,0x14);
    const v6=(((o10&0xff)<<8)|((o10&0xff00)<<16))>>>0;
    if(!(o14===0x20204000 && (((v6-0x200)>>>0)<=0xfe00) && ((((v6-1)&v6)>>>0)===0))) throw new Error('这不是受支持的 KGMusicV3.db，或数据库版本已变化。');
    const expected=page1.slice(0x10,0x18); page1.set(page1.slice(8,16),0x10);
    const dec1=await decryptDBPage(page1.subarray(0x10),1); page1.set(dec1,0x10);
    if(!equalAt(page1,expected,0x10)) throw new Error('数据库首页完整性校验失败：当前内置 master key 不适配此酷狗版本。');
    page1.set(SQLITE_HEADER,0); buf.set(page1,0);
    const pages=buf.length/0x400;
    const batch=32;
    for(let start=2;start<=pages;start+=batch){
      const end=Math.min(pages,start+batch-1);
      const jobs=[];
      for(let p=start;p<=end;p++){
        const off=(p-1)*0x400, page=buf.slice(off,off+0x400);
        jobs.push(decryptDBPage(page,p).then(dec=>({p,dec})));
      }
      const rs=await Promise.all(jobs); for(const {p,dec} of rs) buf.set(dec,(p-1)*0x400);
      onProgress(end/pages,`正在解密密钥数据库：${end}/${pages} 页`);
      await new Promise(r=>setTimeout(r,0));
    }
    return buf;
  }

  function readVarint(a,pos){
    let v=0n;
    for(let i=0;i<8;i++){ const b=a[pos+i]; v=(v<<7n)|BigInt(b&0x7f); if(!(b&0x80)) return {value:v,pos:pos+i+1}; }
    v=(v<<8n)|BigInt(a[pos+8]); return {value:v,pos:pos+9};
  }
  function signedBig(bytes){ let v=0n; for(const b of bytes)v=(v<<8n)|BigInt(b); const bits=BigInt(bytes.length*8); if(v&(1n<<(bits-1n)))v-=1n<<bits; return v; }
  function serialLength(t){ if(t===0||t===8||t===9)return 0; if(t===1)return 1;if(t===2)return 2;if(t===3)return 3;if(t===4)return 4;if(t===5)return 6;if(t===6||t===7)return 8;if(t>=12)return Math.floor((t-(t%2===0?12:13))/2); throw new Error(`不支持的 SQLite serial type: ${t}`); }
  function decodeText(bytes,encoding){ if(encoding===2)return new TextDecoder('utf-16le').decode(bytes); if(encoding===3){const x=bytes.slice();for(let i=0;i+1<x.length;i+=2){const t=x[i];x[i]=x[i+1];x[i+1]=t;}return new TextDecoder('utf-16le').decode(x);} return td.decode(bytes); }
  function decodeRecord(payload,encoding){
    let h=readVarint(payload,0), headerSize=Number(h.value), p=h.pos; const types=[];
    while(p<headerSize){const r=readVarint(payload,p);types.push(Number(r.value));p=r.pos;}
    let d=headerSize; const values=[];
    for(const t of types){ const n=serialLength(t), b=payload.subarray(d,d+n); d+=n;
      if(t===0)values.push(null); else if(t>=1&&t<=6){const z=signedBig(b);values.push(z<=BigInt(Number.MAX_SAFE_INTEGER)&&z>=BigInt(Number.MIN_SAFE_INTEGER)?Number(z):z);} else if(t===7){values.push(new DataView(b.buffer,b.byteOffset,8).getFloat64(0,false));} else if(t===8)values.push(0); else if(t===9)values.push(1); else if(t>=12&&t%2===0)values.push(b.slice()); else values.push(decodeText(b,encoding));
    }
    return values;
  }

  class MiniSQLite {
    constructor(bytes){
      this.a=bytes;
      if(!startsWith(bytes,SQLITE_HEADER))throw new Error('解密结果不是 SQLite 数据库。');
      let ps=be16(bytes,16); this.pageSize=ps===1?65536:ps; this.reserved=bytes[20]; this.usable=this.pageSize-this.reserved; this.encoding=be32(bytes,56)||1;
      if(this.pageSize<512 || (this.pageSize&(this.pageSize-1))) throw new Error(`SQLite 页大小异常：${this.pageSize}`);
    }
    pageStart(n){const p=(n-1)*this.pageSize;if(p<0||p>=this.a.length)throw new Error(`SQLite 页号越界：${n}`);return p;}
    localPayloadSize(P){const U=this.usable,X=U-35,M=Math.floor(((U-12)*32)/255)-23;if(P<=X)return P;const K=M+((P-M)%(U-4));return K<=X?K:M;}
    readPayload(cellPos,P){const local=this.localPayloadSize(P);const out=new Uint8Array(P);out.set(this.a.subarray(cellPos,cellPos+local));let used=local;if(used<P){let pg=be32(this.a,cellPos+local);const seen=new Set();while(pg&&used<P){if(seen.has(pg))throw new Error('SQLite overflow 页形成循环。');seen.add(pg);const s=this.pageStart(pg),next=be32(this.a,s),take=Math.min(this.usable-4,P-used);out.set(this.a.subarray(s+4,s+4+take),used);used+=take;pg=next;}}if(used!==P)throw new Error('SQLite overflow 数据不完整。');return out;}
    *rows(root){yield* this.walk(root,new Set());}
    *walk(pageNo,seen){if(seen.has(pageNo))return;seen.add(pageNo);const s=this.pageStart(pageNo),h=s+(pageNo===1?100:0),type=this.a[h],n=be16(this.a,h+3),header=type===5?12:8;
      if(type===5){for(let i=0;i<n;i++){const ptr=be16(this.a,h+header+i*2),child=be32(this.a,s+ptr);yield* this.walk(child,seen);}yield* this.walk(be32(this.a,h+8),seen);return;}
      if(type!==13)throw new Error(`只支持 SQLite table b-tree，遇到页类型 0x${type.toString(16)}。`);
      for(let i=0;i<n;i++){const ptr=be16(this.a,h+header+i*2);let p=s+ptr;const q=readVarint(this.a,p);p=q.pos;const rowid=readVarint(this.a,p);p=rowid.pos;const payload=this.readPayload(p,Number(q.value));yield {rowid:rowid.value,values:decodeRecord(payload,this.encoding)};}
    }
    schema(){return Array.from(this.rows(1),r=>r.values);}
  }

  function splitSqlColumns(sql){
    const l=sql.indexOf('('),r=sql.lastIndexOf(')');if(l<0||r<=l)return[];const body=sql.slice(l+1,r),parts=[];let cur='',depth=0,quote='';
    for(let i=0;i<body.length;i++){const c=body[i];if(quote){cur+=c;if(quote==='['){if(c===']')quote='';}else if(c===quote){if(body[i+1]===quote){cur+=body[++i];}else quote='';}continue;}if(c==='"'||c==="'"||c==='`'||c==='['){quote=c;cur+=c;continue;}if(c==='(')depth++;else if(c===')')depth--;if(c===','&&depth===0){parts.push(cur.trim());cur='';}else cur+=c;}if(cur.trim())parts.push(cur.trim());
    const skip=/^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;return parts.filter(x=>!skip.test(x)).map(x=>{x=x.trim();if(x[0]==='['){const e=x.indexOf(']');return x.slice(1,e);}if(x[0]==='"'||x[0]==="'"||x[0]==='`'){const q=x[0];let e=1;while(e<x.length&&x[e]!==q)e++;return x.slice(1,e);}return (x.match(/^[^\s]+/)||[''])[0];});
  }

  function extractKggKeyMap(sqliteBytes,onProgress=()=>{}){
    const db=new MiniSQLite(sqliteBytes);let root=0,sql='';
    for(const row of db.schema()){if(String(row[1])==='ShareFileItems'&&String(row[0]).toLowerCase()==='table'){root=Number(row[3]);sql=String(row[4]||'');break;}}
    if(!root)throw new Error('数据库中没有 ShareFileItems 表。');
    const cols=splitSqlColumns(sql),idIdx=cols.indexOf('EncryptionKeyId'),keyIdx=cols.indexOf('EncryptionKey');
    if(idIdx<0||keyIdx<0)throw new Error('ShareFileItems 表结构不含 EncryptionKeyId/EncryptionKey。');
    const map=new Map();let count=0;for(const {values} of db.rows(root)){const id=values[idIdx],key=values[keyIdx];if(id!=null&&key!=null&&String(id)&&String(key))map.set(String(id),String(key));if(++count%1000===0)onProgress(0,`正在读取密钥：${count} 条`);}return map;
  }

  function parseKggKeyText(text){const m=new Map();for(const rawLine of text.split(/\r?\n/)){const line=rawLine.trim();if(!line||line.startsWith('#'))continue;const p=line.indexOf('$');if(p>0){const id=line.slice(0,p).trim(),key=line.slice(p+1).trim();if(id&&key)m.set(id,key);}}return m;}

  function teaDecryptBlock(block,key){
    const dv=new DataView(block.buffer,block.byteOffset,8),kd=new DataView(key.buffer,key.byteOffset,16);let v0=dv.getUint32(0,false),v1=dv.getUint32(4,false),sum=0xc6ef3720>>>0;const k=[0,4,8,12].map(o=>kd.getUint32(o,false));
    for(let i=0;i<32;i++){
      const m1=((((v0<<4)>>>0)+k[2])>>>0)^((v0+sum)>>>0)^(((v0>>>5)+k[3])>>>0);
      v1=(v1-m1)>>>0;
      const m0=((((v1<<4)>>>0)+k[0])>>>0)^((v1+sum)>>>0)^(((v1>>>5)+k[1])>>>0);
      v0=(v0-m0)>>>0;
      sum=(sum-0x9e3779b9)>>>0;
    }
    const out=new Uint8Array(8),od=new DataView(out.buffer);od.setUint32(0,v0,false);od.setUint32(4,v1,false);return out;
  }
  function xor8(a,b){const o=new Uint8Array(8);for(let i=0;i<8;i++)o[i]=a[i]^b[i];return o;}
  function decryptTencentTea(input,key){
    if(input.length%8||input.length<16)throw new Error('腾讯 TEA 密文长度异常。');
    let dest=teaDecryptBlock(input.subarray(0,8),key),pad=dest[0]&7,outLen=input.length-1-pad-2-7;if(outLen<0)throw new Error('腾讯 TEA 填充异常。');
    const out=new Uint8Array(outLen);let ivPrev=new Uint8Array(8),ivCur=input.subarray(0,8),inPos=8,destIdx=1+pad;
    const crypt=()=>{ivPrev=ivCur;ivCur=input.subarray(inPos,inPos+8);dest=teaDecryptBlock(xor8(dest,ivCur),key);inPos+=8;destIdx=0;};
    for(let i=1;i<=2;){if(destIdx<8){destIdx++;i++;}else crypt();}
    for(let p=0;p<outLen;){if(destIdx<8){out[p++]=dest[destIdx]^ivPrev[destIdx];destIdx++;}else crypt();}
    for(let i=0;i<7;i++){if(destIdx>=8)crypt();if(dest[destIdx]!==ivPrev[destIdx])throw new Error('腾讯 TEA 尾部校验失败。');destIdx++;}
    return out;
  }
  function simpleMakeKey(salt,len){const a=new Uint8Array(len);for(let i=0;i<len;i++)a[i]=Math.floor(Math.abs(Math.tan(salt+i*0.1))*100)&255;return a;}
  function deriveKeyV1(raw){if(raw.length<16)throw new Error('ekey 长度过短。');const s=simpleMakeKey(106,8),tea=new Uint8Array(16);for(let i=0;i<8;i++){tea[i*2]=s[i];tea[i*2+1]=raw[i];}return concatBytes(raw.subarray(0,8),decryptTencentTea(raw.subarray(8),tea));}
  function deriveKggKey(ekey){let raw=base64ToBytes(ekey);if(startsWith(raw,RAW_KEY_PREFIX_V2)){raw=raw.subarray(RAW_KEY_PREFIX_V2.length);raw=decryptTencentTea(raw,V2_KEY1);raw=decryptTencentTea(raw,V2_KEY2);raw=base64ToBytes(td.decode(raw));}return deriveKeyV1(raw);}

  class QmcMap{constructor(key){this.key=key;this.n=key.length;}mask(off){if(off>0x7fff)off%=0x7fff;const idx=(off*off+71214)%this.n,v=this.key[idx],r=((idx&7)+4)%8;return ((v<<r)|(v>>r))&255;}decrypt(buf,off=0){for(let i=0;i<buf.length;i++)buf[i]^=this.mask(off+i);}}
  class QmcRC4{
    constructor(key){this.key=key;this.n=key.length;this.box=new Uint8Array(this.n);for(let i=0;i<this.n;i++)this.box[i]=i;let j=0;for(let i=0;i<this.n;i++){j=(j+this.box[i]+key[i%this.n])%this.n;const t=this.box[i];this.box[i]=this.box[j];this.box[j]=t;}this.hash=1;for(const v of key){if(!v)continue;const nx=Math.imul(this.hash,v)>>>0;if(!nx||nx<=this.hash)break;this.hash=nx;}}
    skip(id){const seed=this.key[id%this.n];if(!seed)throw new Error('RC4 分段 seed 为 0，当前 ekey 无法安全处理。');return Math.trunc(this.hash/((id+1)*seed)*100)%this.n;}
    first(buf,off){for(let i=0;i<buf.length;i++)buf[i]^=this.key[this.skip(off+i)];}
    segment(buf,off){const box=this.box.slice();let j=0,k=0,skip=(off%5120)+this.skip(Math.floor(off/5120));for(let i=-skip;i<buf.length;i++){j=(j+1)%this.n;k=(box[j]+k)%this.n;const t=box[j];box[j]=box[k];box[k]=t;if(i>=0)buf[i]^=box[(box[j]+box[k])%this.n];}}
    decrypt(buf,off=0){let left=buf.length,p=0;if(off<128){const n=Math.min(left,128-off);this.first(buf.subarray(0,n),off);off+=n;p+=n;left-=n;}if(left&&off%5120){const n=Math.min(left,5120-off%5120);this.segment(buf.subarray(p,p+n),off);off+=n;p+=n;left-=n;}while(left>5120){this.segment(buf.subarray(p,p+5120),off);off+=5120;p+=5120;left-=5120;}if(left)this.segment(buf.subarray(p),off);}
  }
  function createQmc(ekey){const key=deriveKggKey(ekey);return key.length>300?new QmcRC4(key):new QmcMap(key);}

  function parseKggHeader(a){if(a.length<0x48)throw new Error('KGG 文件过短。');if(!equalAt(a,KGG_MAGIC))throw new Error('KGG magic 不匹配。');const headerLen=le32(a,0x10),ver=le32(a,0x14);if(ver!==5)throw new Error(`只支持 KGG CryptoVersion 5，当前为 ${ver}。`);const hashLen=le32(a,0x44);if(!hashLen||hashLen>256||0x48+hashLen>a.length)throw new Error('KGG audio hash 长度异常。');return {headerLen,audioHash:td.decode(a.subarray(0x48,0x48+hashLen)).replace(/\0+$/,'')};}
  async function decryptKgg(bytes,keyMap,onProgress=()=>{}){const h=parseKggHeader(bytes),ekey=keyMap.get(h.audioHash)||keyMap.get(h.audioHash.toUpperCase())||keyMap.get(h.audioHash.toLowerCase());if(!ekey)throw new Error(`密钥库中找不到此歌曲的 ekey：${h.audioHash}`);if(h.headerLen>=bytes.length)throw new Error('KGG 音频偏移越界。');const out=bytes.slice(h.headerLen),q=createQmc(ekey),chunk=1024*1024;for(let p=0;p<out.length;p+=chunk){q.decrypt(out.subarray(p,Math.min(out.length,p+chunk)),p);onProgress(Math.min(1,(p+chunk)/out.length),`正在解密 KGG：${Math.min(out.length,p+chunk)}/${out.length} 字节`);await new Promise(r=>setTimeout(r,0));}return out;}


  function detectAudio(bytes){
    if(equalAt(bytes,te.encode('fLaC')))return {ext:'flac',mime:'audio/flac'};
    if(equalAt(bytes,te.encode('OggS')))return {ext:'ogg',mime:'audio/ogg'};
    if(equalAt(bytes,te.encode('RIFF'))&&equalAt(bytes,te.encode('WAVE'),8))return {ext:'wav',mime:'audio/wav'};
    if(equalAt(bytes,te.encode('ID3'))||(bytes[0]===0xff&&(bytes[1]&0xe0)===0xe0))return {ext:'mp3',mime:'audio/mpeg'};
    if(bytes.length>12&&equalAt(bytes,te.encode('ftyp'),4))return {ext:'m4a',mime:'audio/mp4'};
    if(bytes[0]===0xff&&(bytes[1]&0xf6)===0xf0)return {ext:'aac',mime:'audio/aac'};
    return {ext:'bin',mime:'application/octet-stream'};
  }

  window.KugouCore={decryptKugouDatabase,extractKggKeyMap,parseKggKeyText,decryptKgg,detectAudio,md5Bytes,parseKggHeader,bytesToBase64,__test:{deriveKggKey,teaDecryptBlock,decryptTencentTea,QmcMap,QmcRC4,derivePageAESKey,derivePageAESIV}};
})();

  
  
