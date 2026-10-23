const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {fixture}=require('./helpers/engine.cjs');
const source=fs.readFileSync('js/app.js','utf8');
function controller(){
  const context=vm.createContext({FRAME_TARGET_MS:1000/120});
  vm.runInContext(source.slice(source.indexOf('  class HighRefreshController {'),source.indexOf('  const highRefreshController ='))+'\nglobalThis.Cadence=HighRefreshController;',context);
  const c=new context.Cadence();c.start();return c;
}

test('120 Hz is measured from delivered callbacks and keeps an 8.33 ms budget',()=>{
  const c=controller();for(let i=0;i<60;i++)c.observe(1000/120);
  assert(Math.abs(c.measuredHz()-120)<1e-8);assert(Math.abs(c.targetMs()-1000/120)<1e-8);
  c.observe(1000/60);
  assert(c.measuredHz()<120,'a skipped vblank must be visible in the actual cadence');
  assert(Math.abs(c.targetMs()-1000/120)<1e-8,'one skipped vblank must not halve the rendering budget');
});

test('a browser delivering 60 Hz is reported as 60, and 110 is not rounded to 120',()=>{
  for(const hz of [60,90,110,120,144]){
    const c=controller();for(let i=0;i<60;i++)c.observe(1000/hz);
    assert(Math.abs(c.measuredHz()-hz)<1e-8,`${hz} Hz`);
  }
});

test('gameplay follows every rAF without a timer gate and never schedules duplicate loops',()=>{
  const callbacks=[];
  const {probe:p,context}=fixture({requestAnimationFrame:cb=>{callbacks.push(cb);return callbacks.length;}});
  p.raf=0;p.bound={loop(){}};
  const schedule=context.Engine.prototype.scheduleLoop;
  schedule.call(p);schedule.call(p);assert.equal(callbacks.length,1);
  p.raf=0;schedule.call(p);assert.equal(callbacks.length,2);
  p.raf=0;p.streamBuffering=true;schedule.call(p);assert.equal(callbacks.length,2);
});
