const {parentPort,workerData}=require('node:worker_threads');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
globalThis.self=globalThis;
globalThis.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);
globalThis.importScripts=(...urls)=>{for(const url of urls)vm.runInThisContext(fs.readFileSync(path.resolve(path.dirname(workerData.script),url),'utf8'),{filename:url});};
vm.runInThisContext(fs.readFileSync(workerData.script,'utf8'),{filename:workerData.script});
parentPort.on('message',data=>self.onmessage({data}));
