import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevServer } from './dev-serve.mjs';
const server=createDevServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,output=await mkdtemp(join(tmpdir(),'muzil-match-'));
const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[],checks=[];
const menu=async p=>{if(!await p.locator('#site-menu').evaluate(el=>el.open))await p.locator('#site-menu summary').click();};
try {
 const pages=await Promise.all([browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'})]);
 const [a,b]=pages;
 for(const p of pages){p.on('pageerror',e=>errors.push(e.message));await p.goto(origin);await menu(p);await p.locator('#race-peer').click();}
 await a.locator('#make-offer').click();await a.waitForFunction(()=>document.querySelector('#peer-output').value.startsWith('ey'));
 await b.locator('#peer-input').fill(await a.locator('#peer-output').inputValue());await b.locator('#join-offer').click();await b.waitForFunction(()=>document.querySelector('#peer-output').value.startsWith('ey'));
 await a.locator('#peer-input').fill(await b.locator('#peer-output').inputValue());await a.locator('#accept-answer').click();
 for(const p of pages){await p.waitForFunction(()=>document.querySelector('#mesh-state').textContent.includes('Peer connected'));await p.locator('#mesh-dialog .close-dialog').click();}
 const now=Date.now();for(const p of pages){await p.clock.install({time:now});await p.clock.pauseAt(now+1000);}
 await menu(a);await a.locator('#race-peer').click();await b.locator('#accept-race').click();
 for(let round=0;round<3;round++) {
  for(const p of pages)await p.locator('#race-status').getByText(/starts in/).waitFor();
  for(const p of pages)await p.clock.runFor(3250);
  const records=[];
  for(const p of [pages[round===1?1:0]]) {
   const tap=t=>p.locator(`[data-action="${t}"]`).first().click();
   const app=async name=>{await p.locator('#phone-home').click();if(await p.locator('.notification-open').count()){await p.locator('.notification-open').click();await tap('bait:inspect');await p.locator('#phone-home').click();}await tap(`app:${name}`);};
   await p.locator('#dismiss-reveal').click();await app('calendar');await p.locator('#phone-home').click();
   // Leaving Calendar is a real progress trigger. Inspect its update before drafting.
   await p.locator('.notification-open').click();await tap('bait:inspect');
   const text=await p.locator('#phone-screen').textContent();
   const end=text.match(/finishes at (\d\d:\d\d)/)[1],place=text.match(/Pickup at the ([^.]+)\./)[1];
   if(round>0){await app('clock');if(round===2)await p.locator('[data-action^="alarm-edit:"]').first().click();const [h,m]=end.split(':').map(Number),minutes=h*60+m-10;const alarm=`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;await p.locator('[data-field="alarm"]').fill(alarm);await tap('save-alarm');}
   if(round===1){await app('notes');await p.locator('[data-field="note"]').fill(`Pickup: ${place}`);}
   await app('messages');await tap('contact:parent');await p.locator('#phone-reply').fill(`${end}, ${place}`);await p.getByRole('button',{name:'Send message',exact:true}).click();await p.locator('#next-round').waitFor();

  }
  for(const p of pages){await p.locator('#next-round').waitFor();records.push(await p.evaluate(()=>JSON.parse(localStorage.getItem('muzil.replay.v1'))));}
  assert.deepEqual(records[0].scenario,records[1].scenario);assert.equal(records[0].scenario.family,['coordinate','prepare','repair'][round]);
  for(const p of pages)await p.locator('#race-status').getByText(round<2?/complete/:/won the match/).waitFor();
  await a.screenshot({path:join(output,`round-${round+1}.png`),fullPage:true});
  if(round<2){await b.locator('#next-round').click();await a.locator('#next-round').click();}
 }
 checks.push('Actual desktop/mobile Reploid peers: shared countdown, identical generated scenarios and recorded pressure, three task families, first correct finish ends the opponent round, readiness between rounds, final series score over one retained connection');
 await menu(a);await a.locator('#race-peer').click();await b.locator('#accept-race').click();for(const p of pages)await p.locator('#race-status').getByText(/starts in/).waitFor();
 checks.push('Finished match can invite a fresh match without reconnecting');
 assert.deepEqual(errors,[]);const report={output,checks,errors};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
