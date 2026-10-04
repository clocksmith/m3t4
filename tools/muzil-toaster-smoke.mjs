import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevServer } from './dev-serve.mjs';
import { TOAST_TASKS } from '../client/muzil/toaster-entry.mjs';
import { readFile } from 'node:fs/promises';
const catalog=JSON.parse(await readFile(new URL('../client/muzil/challenges.json',import.meta.url),'utf8')).challenges;
const server=createDevServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=process.env.MUZIL_SMOKE_ORIGIN || `http://127.0.0.1:${server.address().port}`;
const output=await mkdtemp(join(tmpdir(),'muzil-toaster-'));
const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[],checks=[];
try {
 for(const width of [1440,390,320]) {
  const page=await browser.newPage({viewport:{width,height:900},hasTouch:width!==1440,isMobile:width!==1440});
  page.on('pageerror',e=>errors.push(e.message));await page.goto(origin + '/muzil/');await page.locator('#toaster-dial:not(:disabled)').waitFor();
  const dial=page.locator('#toaster-dial');await dial.press('Home');assert.equal(await dial.inputValue(),'1');assert.match(await dial.getAttribute('aria-valuetext'),/Set an alarm/);
  await dial.press('ArrowRight');assert.equal(await dial.inputValue(),'2');await dial.click();assert.equal(await dial.inputValue(),'3');
  const box=await dial.boundingBox(),x=box.x+box.width/2,y=box.y+box.height/2;
  await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+40,y-40,{steps:5});await page.mouse.up();assert.equal(await dial.inputValue(),'5');
  if(width!==1440) {
   const session=await page.context().newCDPSession(page);const scroll=await page.evaluate(()=>scrollY);
   await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
   await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-35,y:y+35}]});
   await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   assert.equal(await dial.inputValue(),'1');assert.equal(await page.evaluate(()=>scrollY),scroll);
   await page.touchscreen.tap(x,y);assert.equal(await dial.inputValue(),'2');await session.detach();
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(output,`dial-${width}.png`),fullPage:true});
  await page.locator('#toaster-lever').click();assert.equal(await dial.isDisabled(),true);
  await page.waitForFunction(()=>document.querySelector('.toaster-scene').classList.contains('launching'));
  assert.equal(await page.locator('.toaster-smoke i').count(),4);
  assert.ok(await page.locator('.toaster-sparks').evaluate(el=>el.getAnimations().some(a=>a.playState==='running')));
  assert.ok(await page.locator('.toaster-smoke i').first().evaluate(el=>el.getAnimations().some(a=>a.playState==='running')));
  await page.waitForFunction(()=>document.getElementById('peek-phone').getAnimations().some(a=>a.playState==='running'&&a.effect.getTiming().duration===600));
  const apex=await page.locator('#peek-phone').evaluate(el=>{
   const a=el.getAnimations().find(a=>a.playState==='running'&&a.effect.getTiming().duration===600);a.pause();window.apex=a;
   const box=el.getBoundingClientRect(),scene=el.closest('.toaster-scene').getBoundingClientRect();
   el.style.pointerEvents='auto';const front=document.elementFromPoint(box.x+box.width/2,box.y+12)?.closest('#peek-phone')===el;el.style.pointerEvents='';
   return {aboveScene:box.y<scene.y,front};
  });assert.deepEqual(apex,{aboveScene:true,front:true});
  await page.screenshot({path:join(output,`apex-${width}.png`),fullPage:true});
  await page.evaluate(()=>window.apex.play());
  await page.waitForFunction(()=>document.getElementById('phone').getAnimations().some(a=>a.playState==='running'));
  assert.equal(await page.locator('#game-stage').evaluate(el=>el.inert),true);
  assert.equal(await page.locator('#task-note-content').getAttribute('data-visible'),'false');
  await page.locator('#dismiss-reveal').waitFor();
  const selectedTask=TOAST_TASKS[Number(await dial.inputValue())-1];
  const duration=catalog.find(c=>c.id===selectedTask.id).durationMs/1000;
  assert.equal(await page.locator('#round-clock').textContent(),`${String(Math.floor(duration/60)).padStart(2,'0')}:${String(duration%60).padStart(2,'0')}`);
  assert.equal(await page.locator('#game-stage').evaluate(el=>el.inert),false);
  await page.close();
 }
 checks.push('1440/390/320px: keyboard, click and drag dial; real touch input without scrolling; label and pointer update; unclipped phone holds above scene; expansion blocks input and starts round with full clock');
 const settings=[];
 for(const level of [1,5]) {
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.toastAnimations=[];const animate=Element.prototype.animate;Element.prototype.animate=function(frames,options){if(this.id==='peek-phone')window.toastAnimations.push({frames,options});return animate.call(this,frames,options);};});
  await page.goto(origin + '/muzil/');await page.locator('#toaster-dial:not(:disabled)').waitFor();await page.locator('#toaster-dial').press(level===1?'Home':'End');await page.locator('#start-round').click();await page.locator('#dismiss-reveal').waitFor();settings.push(await page.evaluate(()=>window.toastAnimations));await page.close();
 }
 assert.ok(settings[1][1].options.duration>settings[0][1].options.duration);assert.notEqual(settings[1][2].frames.at(-1).transform,settings[0][2].frames.at(-1).transform);
 checks.push('Toast setting changes actual warm-up duration and pop height; lever and start button share the same entry');
 const reduced=await browser.newPage({reducedMotion:'reduce'});await reduced.goto(origin + '/muzil/');await reduced.locator('#toaster-dial:not(:disabled)').waitFor();await reduced.locator('#toaster-dial').press('End');await reduced.locator('#start-round').click();await reduced.locator('#dismiss-reveal').waitFor();assert.equal(await reduced.locator('#phone').evaluate(el=>el.getAnimations().length),0);await reduced.close();
 checks.push('Reduced motion keeps the dial functional and skips the animated entry');
 for(let index=0;index<TOAST_TASKS.length;index++) {
  const task=TOAST_TASKS[index],page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await page.goto(origin + '/muzil/');await page.locator('#toaster-dial:not(:disabled)').waitFor();
  await page.locator('#toaster-dial').press('Home');
  for(let step=0;step<index;step++)await page.locator('#toaster-dial').press('ArrowRight');
  assert.equal(await page.locator('#challenge-select').inputValue(),task.id);
  assert.equal(await page.locator('#toast-setting').textContent(),`${index+1} · ${task.label}`);
  assert.equal(await page.locator('#peek-phone').evaluate(el=>parseFloat(getComputedStyle(el).top)),81+index*10);
  await page.locator(index%2?'#toaster-lever':'#start-round').click();
  assert.equal(await page.locator('#task-note-content p').textContent(),catalog.find(c=>c.id===task.id).intention);
  assert.equal(await page.locator('.toaster-sparks').evaluate(el=>el.getAnimations().length),0);
  const phone=await page.locator('#phone').boundingBox();assert.ok(phone.y+phone.height<=844-24);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight),false);
  await page.close();
 }
 checks.push('All five settings launch their own real task; phone insertion increases monotonically; no effects with reduced motion; full phone fits without page scrolling');
 assert.deepEqual(errors,[]);const report={output,checks,errors};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.error(error);throw error;}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
