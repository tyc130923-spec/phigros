const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {Worker}=require('node:worker_threads');
function decode(bytes,expectedSize){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(path.resolve('tests/helpers/browser-worker.cjs'),{workerData:{script:path.resolve('js/chart-decode-worker.js')}});
    worker.once('message',message=>{worker.terminate();resolve(message);});
    worker.once('error',error=>{worker.terminate();reject(error);});
    worker.postMessage({bytes:new Uint8Array(bytes),expectedSize});
  });
}
test('all shipped LZMA charts decode in the worker to byte-identical original JSON',async()=>{
  const cases=JSON.parse(fs.readFileSync('tests/fixtures/chart-reference-sha256.json','utf8'));
  assert(cases.length>30);
  for(const item of cases){
    const result=await decode(fs.readFileSync(item.url),item.usize);
    assert.equal(result.ok,true,item.id+': '+result.error);
    assert.equal(crypto.createHash('sha256').update(result.bytes).digest('hex'),item.sha256,item.id);
    assert.equal(typeof JSON.parse(Buffer.from(result.bytes).toString()),'object');
  }
});
test('wrong decompressed size is rejected instead of silently playing a damaged chart',async()=>{
  const item=JSON.parse(fs.readFileSync('tests/fixtures/chart-reference-sha256.json'))[0];
  const result=await decode(fs.readFileSync(item.url),item.usize+1);
  assert.equal(result.ok,false);assert.match(result.error,/长度/);
});
