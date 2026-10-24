const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {run}=require('./helpers/rapid-input.cjs');
test('ten two-finger taps stay ten across 1200 delayed, omitted-start and reused-ID schedules',()=>{
  let cases=0;
  for(const spacing of [8,16,32,50,80])for(const factor of [.75,1.5])for(const td of [0,10,50,100])for(const pd of [0,10,50])
    for(const dropP of [0,682,585])for(const dropT of [0,682,585])for(const reuse of [true,false]){
      if(dropP&dropT)continue;
      const config={spacing,duration:spacing*factor,td,pd,dropP,dropT,reuse},result=run(config),label=JSON.stringify(config);
      assert.equal(result.edges,10,label);assert.equal(result.remaining,0,label);
      assert.deepEqual(Array.from(result.receipts,r=>Math.round(r.at-1000)).sort((a,b)=>a-b),Array.from({length:10},(_,i)=>i*spacing),label);
      cases++;
    }
  assert.equal(cases,1200);
});
test('receipt history stays bounded during a long sequence of alternating taps',()=>{
  const result=run({spacing:50,duration:75,td:50,pd:10,count:300});
  assert.equal(result.edges,300);assert.equal(result.remaining,0);assert(result.receipts.length<=128);
});
test('the delayed two-source sequence judges all ten real blue heads without extra presses',()=>{
  const source=fs.readFileSync('js/app.js','utf8');
  const result=run({spacing:50,duration:75,td:50,pd:10,dropP:682,prepare(p,context,contacts){
    Object.assign(context,{nativeBlockTouchBlocked:()=>false,judgeTimingLead:0,specialJudgeDelay:0});
    vm.runInContext(source.slice(source.indexOf('  function lowerBoundNumeric('),source.indexOf('  function eventValueFast(')),context);
    p.tryTap=context.Engine.prototype.tryTap;p.candidateScratch={};p.lineScreen=()=>({cx:500,cy:250,ux:1,uy:0});
    p.noteItems=contacts.map(c=>{const n={type:1,time:40+c.at/1000,x:0,state:0,fake:false},item={L:{id:0},n};n._item=item;return item;});
    p.noteTimes=Float64Array.from(p.noteItems,item=>item.n.time);p.pendingJudge=new Set();p.commits=[];
    p.commit=(n,j,diff)=>{n.state=1;p.commits.push({n,j,diff});};
  }});
  assert.equal(result.edges,10);assert.equal(result.commits.length,10);assert(result.commits.every(x=>x.j<=1));
});
