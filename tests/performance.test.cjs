const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {fixture}=require('./helpers/engine.cjs');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync('js/performance-policy.js','utf8'),context);
const policy=context.PhiPerformance;

test('render pixel budgets bound Retina and 4K surfaces without changing CSS geometry',()=>{
  for(const [w,h,native,options,limit] of [[1366,1024,2,{},4e6],[1920,1080,3,{heavy:true},3e6],[1280,800,2,{cores:4},2e6],[3840,2160,2,{},5e6]]){
    const dpr=policy.renderDpr(w,h,native,options);
    assert(dpr<=native&&dpr<=2);assert(w*h*dpr*dpr<=limit+1);
  }
  assert.equal(policy.renderDpr(800,600,1),1);
});
test('startup buffers remain bounded on slow mobile links instead of waiting for most of a song',()=>{
  assert.equal(policy.startupBuffer(160,4,3),6);
  assert.equal(policy.startupBuffer(160,1.3,3),8);
  assert.equal(policy.startupBuffer(160,.5,3),12);
  assert.equal(policy.startupBuffer(4,.5,3),4);
  assert.equal(policy.startupBuffer(160,20,.1),8,'one early burst must not short-circuit the safety margin');
});
test('resource cache evicts cold entries by size and preserves recently used active values',()=>{
  const cache=new policy.ResourceCache(10,4);
  cache.set('a','alpha');cache.setWeight('a',4);cache.set('b','beta');cache.setWeight('b',4);
  assert.equal(cache.get('a'),'alpha');cache.set('c','gamma');cache.setWeight('c',4);
  assert.equal(cache.has('b'),false);assert.equal(cache.get('a'),'alpha');assert.equal(cache.bytes,8);
  cache.set('huge','keep externally');cache.setWeight('huge',20);
  assert.equal(cache.size,0);assert.equal(cache.bytes,0);
});
test('resource cache bounds unresolved requests and replaces weights without leaking accounting',()=>{
  const cache=new policy.ResourceCache(100,2);
  for(let i=0;i<5;i++)cache.set(i,Promise.resolve(i));
  assert.equal(cache.size,2);cache.setWeight(0,80);assert.equal(cache.bytes,0);
  cache.setWeight(4,20);cache.setWeight(4,10);assert.equal(cache.bytes,10);
  cache.delete(4);assert.equal(cache.bytes,0);
});

test('touch geometry computes only the requested line and parent, leaving render geometry unchanged',()=>{
  const {probe,context}=fixture();
  context.eventValueFast=(events,t,fallback)=>events?.length?events[0].value+events[0].slope*t:fallback;
  context.rpeLayerValueFast=context.eventValueFast;
  context.DEFAULT_LINE_COLOR=[255,255,255];
  probe.frameLines=[];probe.inputFrameLines=[];probe.frameStamp=0;probe.inputFrameStamp=0;probe.inputFrameTime=NaN;
  probe.chart.lines=Array.from({length:200},(_,id)=>({id,isRPE:true,moveX:[{value:id/200,slope:.01}],moveY:[],rotate:[],alpha:[],floorAt:t=>t}));
  probe.chart.lines[199].parent=0;
  probe.prepareFrame(1);
  const renderBefore=JSON.stringify(probe.frameLines),geometry=probe.lineScreen(probe.chart.lines[199],1.02);
  assert.equal(probe.inputFrameLines.filter(Boolean).length,2);
  assert.equal(JSON.stringify(probe.frameLines),renderBefore,'input must never overwrite the frame being drawn');
  const expectedProbe=fixture({eventValueFast:context.eventValueFast,rpeLayerValueFast:context.rpeLayerValueFast,DEFAULT_LINE_COLOR:[255,255,255]}).probe;
  expectedProbe.chart=probe.chart;expectedProbe.frameLines=[];expectedProbe.frameStamp=0;
  expectedProbe.prepareFrame(1.02);
  for(const key of ['x','y','cx','cy','rot','ux','uy','cur','alpha'])assert.equal(geometry[key],expectedProbe.frameLines[199][key],key);
  assert.equal(probe.lineScreen(probe.chart.lines[199],1.021),geometry,'same input sample reuses its dependency cache');
});

test('externalized thumbnails and deferred metadata are local and present',()=>{
  const source=fs.readFileSync('js/app.js','utf8'),html=fs.readFileSync('index.html','utf8');
  for(const name of ['REFERENCE_THUMBNAILS','PHI_RANK_TEXTURES']){
    const map=JSON.parse(source.match(new RegExp('const '+name+'\\s*=\\s*(\\{[^;]+\\});'))[1]);
    for(const path of Object.values(map)){assert(path.startsWith('./assets/'));assert(fs.statSync(path).size>0);}
  }
  for(const [,path] of html.matchAll(/data-src="(\.\/assets\/[^"]+)"/g))assert(fs.statSync(path).size>0);
});
