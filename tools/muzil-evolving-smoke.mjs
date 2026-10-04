import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevServer } from './dev-serve.mjs';
const server=createDevServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,output=await mkdtemp(join(tmpdir(),'muzil-evolving-'));
const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[],checks=[];
try {
 for(const width of [1440,390,320]) {
  const page=await browser.newPage({viewport:{width,height:width===1440?1000:844},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));await page.clock.install();await page.goto(origin + '/muzil/');
  await page.locator('#start-round:not(:disabled)').waitFor();await page.clock.pauseAt(new Date());
  await page.locator('#start-round:not(:disabled)').waitFor({state:'attached'});await page.locator('#challenge-select').evaluate((el,value)=>el.value=value,'changing-coordinate');await page.locator('#start-round').click();await page.locator('#dismiss-reveal').click();
  const tap=t=>page.locator(`[data-action="${t}"]`).first().click();
  const app=async a=>{await page.locator('#phone-home').click();await tap(`app:${a}`);};
  await app('messages');await tap('contact:parent');await page.locator('#phone-reply').fill('My old plan');
  await page.clock.runFor(7000);await page.locator('.notification-open').waitFor();
  const phone=await page.locator('#phone').boundingBox(),banner=await page.locator('.notification-toast').boundingBox();assert.ok(banner.y-phone.y>=40&&banner.y-phone.y<75);
  await page.locator('.notification-open').click();await page.screenshot({path:join(output,`conflict-${width}.png`),fullPage:true});
  assert.equal(await page.locator('.phone-navigation').evaluate(el=>el.inert),true);await tap('bait:inspect');
  await app('messages');await tap('contact:parent');assert.equal(await page.locator('#phone-reply').inputValue(),'My old plan');
  let entrance,finish,alarm,followups=0;
  for(let event=0;event<8 && !alarm;event++) {
   for(let tick=0;tick<180 && !await page.locator('.notification-open').count();tick++)await page.clock.runFor(1000);
   await page.locator('.notification-open').click();
   if(await page.locator('[data-action="bait:answer"]').count()) {
    await tap('bait:answer');assert.equal(await page.locator('[data-action="bait:finish"]').count(),0);
    await page.clock.runFor(4250);
    const updates=await page.locator('.bait-app').textContent();
    entrance=updates.match(/Pickup has moved to the ([^.]+)\./)[1];finish=updates.match(/finish time is still (\d\d:\d\d)/)[1];
    await tap('bait:finish');
   } else if(await page.locator('[data-action="bait:vague"]').count())await tap('bait:vague');
   else if(await page.locator('[data-action="bait:clear"]').count()){followups++;await tap('bait:clear');}
   else {const text=(await page.locator('.bubble').allTextContents()).join(' ');alarm=text.match(/reminder for (\d\d:\d\d)/)?.[1];}
  }
  assert.equal(followups,1);assert.ok(entrance&&finish&&alarm);
  await app('clock');await page.locator('[data-field="alarm"]').fill(alarm);await tap('save-alarm');
  await app('messages');await tap('contact:driver');await page.locator('#phone-reply').pressSequentially(`${finish}, ${entrance}`);await page.getByRole('button',{name:'Send message',exact:true}).click();
  await page.locator('#next-round').waitFor();assert.match(await page.locator('#phone-overlay').textContent(),/resolving interruptions/);
  const record=await page.evaluate(()=>JSON.parse(localStorage.getItem('muzil.replay.v1')));
  assert.equal(record.scenario.family,'coordinate');assert.ok(record.directorEvents.some(e=>e.id==='group-clarify'));
  const check=await page.evaluate(async record=>{const {replay}=await import('/muzil/engine.mjs');const s=replay(record);return {phase:s.phase,edits:s.editEvents,moves:s.semanticActions,mistakes:s.metrics.mistakes};},record);
  assert.equal(check.phase,'finished');assert.equal(check.mistakes,1);assert.ok(check.edits<10,JSON.stringify(check));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(output,`result-${width}.png`),fullPage:true});await page.close();
  checks.push(`${width}px: seeded round, top banner, preserved draft, changed driver/time/entrance, call wait, bounded group follow-up, alarm obligation, coalesced typing, final result and replay`);
 }
 assert.deepEqual(errors,[]);const report={output,checks,errors};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
