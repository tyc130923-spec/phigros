const {fixture}=require('./engine.cjs');
function run({spacing,duration,td,pd,dropP=0,dropT=0,reuse=true,count=10,prepare}){
 const f=fixture(),p=f.probe,contacts=Array.from({length:count},(_,i)=>({i,at:i*spacing,end:i*spacing+duration,pid:2+i%2,tid:reuse?i%2:i,x:480+(i%2)*16}));
 if(prepare)prepare(p,f.context,contacts);
 let edges=0,trace=[];const judge=p.tryTap;p.eventAudioTime=f.context.Engine.prototype.eventAudioTime;p.tryTap=(_id,_x,_y,t)=>{edges++;trace.push(Math.round((t-40)*1000));judge.call(p,_id,_x,_y,t);};
 const active=t=>contacts.filter(c=>c.at<=t&&c.end>t).map(c=>({identifier:c.tid,clientX:c.x,clientY:250}));
 const lists={p:[],t:[]};
 for(const c of contacts){
  for(const [kind,at] of [['down',c.at],['up',c.end]]){
   if(kind==='up'||!(dropP&(1<<c.i)))lists.p.push({source:'p',kind,at,c});
   if(kind==='up'||!(dropT&(1<<c.i)))lists.t.push({source:'t',kind,at,c});
  }
 }
 const events=[];
 for(const key of ['p','t']){let last=-1;for(const e of lists[key].sort((a,b)=>a.at-b.at)){e.delivery=Math.max(e.at+(key==='p'?pd:td),last+.01);last=e.delivery;events.push(e);}}
 for(const e of events.sort((a,b)=>a.delivery-b.delivery)){
  f.setNow(1000+e.delivery);p.time=40+e.delivery/1000;
  const common={timeStamp:1000+e.at,cancelable:true,preventDefault(){}};
  if(e.source==='p')p[e.kind==='down'?'pointerDown':'pointerUp']({...common,pointerType:'touch',pointerId:e.c.pid,clientX:e.c.x,clientY:250});
  else p[e.kind==='down'?'touchStart':'touchEnd']({...common,changedTouches:[{identifier:e.c.tid,clientX:e.c.x,clientY:250}],touches:active(e.at)});
 }
 return {remaining:p.pointer.size,receipts:p.inputDownReceipts||[],commits:p.commits,edges,unique:new Set(trace).size,trace,rawP:p.inputStats.pointerDown,rawT:p.inputStats.touchStart};
}

module.exports={run};
