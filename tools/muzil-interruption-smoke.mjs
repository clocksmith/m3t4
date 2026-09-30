import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevServer } from './dev-serve.mjs';
const server=createDevServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const output=await mkdtemp(join(tmpdir(),'muzil-interruption-'));
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[],checks=[];
try {
 for(const width of [1440,390,320]) {
  const page=await browser.newPage({viewport:{width,height:width===1440?1000:844}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.evaluate(()=>document.fonts.ready);
  assert.deepEqual(await page.locator('#site-menu nav button').allTextContents(),['Play','Watch AI play','Play with a friend']);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:join(output,`toaster-${width}.png`),fullPage:true});
  await page.locator('#toaster-lever').click();await page.locator('#dismiss-reveal').waitFor();
  assert.equal(await page.locator('#phone .task-note').count(),0);
  await page.locator('#dismiss-reveal').click();
  await page.locator('[data-action="app:calendar"]').first().click();
  await page.locator('#remember').click();await page.locator('#task-note-content').getByText('Tell Mom when and where to pick you up.',{exact:true}).waitFor();
  await page.locator('#phone-screen').getByRole('heading',{name:'Calendar',exact:true}).waitFor();
  await page.screenshot({path:join(output,`task-note-${width}.png`),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.close();
 }
 checks.push('Lever starts real rounds at 1440, 390 and 320px; three-choice menu; external task recall preserves Calendar; no overflow');
 const page=await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
 page.on('pageerror',e=>errors.push(e.message));
 await page.clock.install();await page.goto(origin);
 await page.locator('#start-round').click();await page.locator('#dismiss-reveal').click();
 assert.equal(await page.locator('#phone').evaluate(el=>el.getAnimations().length),0);
 await page.locator('[data-action="app:messages"]').first().click();await page.locator('[data-action="contact:mom"]').click();
 await page.locator('#phone-reply').fill('My unfinished reply');
 await page.clock.runFor(7200);
 await page.locator('.interrupting').waitFor();assert.equal(await page.locator('#phone-screen').evaluate(el=>el.inert),true);
 await page.screenshot({path:join(output,'notification.png'),fullPage:true});
 await page.locator('#remember').click();await page.locator('#task-note-content p').getByText('Tell Mom when and where to pick you up.',{exact:true}).waitFor();
 await page.locator('.notification-open').click();
 for(let i=0;i<3;i++)await page.locator(`[data-action="bait:tile:${i}"]`).click();
 await page.locator('.bait-reward').waitFor();assert.equal(await page.locator('#next-round').count(),0);
 await page.screenshot({path:join(output,'reveal-game.png'),fullPage:true});
 await page.locator('[data-action="bait:leave"]').click();assert.equal(await page.locator('#phone-reply').inputValue(),'My unfinished reply');
 await page.locator('#phone-reply').fill('5:40 PM, side entrance');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.locator('#next-round').waitFor();
 const record=await page.evaluate(()=>JSON.parse(localStorage.getItem('muzil.replay.v1')));
 assert.ok(record.elapsed>=7200);assert.equal(record.log.filter(e=>e.action.target.startsWith('bait:tile:')).length,3);
 assert.equal(await page.evaluate(async r=>(await import('/muzil/engine.mjs')).replay(r).phase,record),'finished');
 checks.push('Interrupting notification blocks phone; outside recall still works; reveal consumes time; draft survives; one message completes task; replay reproduces detour');
 await page.locator('#next-round').click();await page.locator('#dismiss-reveal').click();await page.clock.runFor(24000);
 await page.locator('.interrupting .notification-dismiss').click(); // earlier reveal
 await page.locator('.interrupting .notification-open').click(); // pairs at 23 seconds
 await page.locator('.bait-cards').waitFor();
 await page.locator('[data-action="bait:tile:0"]').click();await page.locator('[data-action="bait:tile:1"]').click();
 await page.screenshot({path:join(output,'pairs-game.png'),fullPage:true});
 await page.locator('[data-action="bait:leave"]').click();
 await page.clock.runFor(18000);await page.locator('.interrupting .notification-open').click();
 await page.locator('[data-action="bait:stop"]').waitFor();await page.clock.runFor(550);await page.locator('[data-action="bait:stop"]').click();
 await page.screenshot({path:join(output,'timing-game.png'),fullPage:true});
 assert.equal(await page.locator('[data-action="bait:again"]').count(),1);
 await page.locator('[data-action="bait:leave"]').click();
 checks.push('Matching and timing games open from later notifications and can be left');
 assert.deepEqual(errors,[]);
 const report={output,checks,errors};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
