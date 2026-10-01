import { handleInterruption } from './muzil-smoke-actions.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevServer } from './dev-serve.mjs';
const server = createDevServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = await mkdtemp(join(tmpdir(),'muzil-smoke-'));
async function openMenu(page) { if (!await page.locator('#site-menu').evaluate(el=>el.open)) await page.locator('#site-menu summary').click(); }
const browser = await chromium.launch({channel:'chrome',headless:true});
const errors=[], report={scope:'Local Chrome: real UI and Reploid WebRTC; injected executor tests transport only, not inference or remote networks.',checks:[]};
try {
  const page=await browser.newPage({viewport:{width:1440,height:1050}});
  await page.addLocatorHandler(page.locator('.interrupting .notification-open'), () => handleInterruption(page));
  page.on('pageerror',e=>errors.push(e.message)); const requests=[]; page.on('request',r=>requests.push(r.url()));
  await page.goto(origin); await page.locator('#start-round').waitFor(); await page.evaluate(()=>document.fonts.ready);
  assert.equal(requests.some(u=>u.includes('/vendor/')),false);
  await page.screenshot({path:join(output,'desktop.png'),fullPage:true});
  await page.locator('#start-round').click(); await page.locator('#dismiss-reveal').click();
  await page.screenshot({path:join(output,'desktop-game.png'),fullPage:true});
  await page.locator('[data-action="app:calendar"]').first().click(); await page.getByText('4:50 PM – 5:40 PM').waitFor();
  await page.locator('#phone-home').click(); await page.locator('[data-action="app:notes"]').click();
  assert.match(await page.getByRole('textbox',{name:'Notes',exact:true}).inputValue(),/side entrance/);
  await page.locator('#phone-home').click(); await page.locator('[data-action="app:messages"]').first().click(); await page.locator('[data-action="contact:mom"]').click();
  await page.locator('#phone-reply').fill('Pick me up at 5:40 PM, side entrance.');
  await page.locator('#phone-home').click(); await page.locator('[data-action="app:messages"]').first().click(); await page.locator('[data-action="contact:mom"]').click();
  assert.equal(await page.locator('#phone-reply').inputValue(),'Pick me up at 5:40 PM, side entrance.');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  // The single task is complete when the correct message is sent.
  await page.locator('#next-round').waitFor();
  await page.screenshot({path:join(output,'desktop-result.png'),fullPage:true});
  await page.locator('#result-profile').click(); assert.match(await page.locator('#profile-summary').textContent(),/1 completed/);
  const lesson = await page.evaluate(() => JSON.parse(localStorage.getItem('muzil.profile.v1')));
  assert.equal(lesson.examples.at(-1).action.target, 'send');
  assert.equal(lesson.examples.at(-1).after.phase, 'finished');
  await page.locator('#replay-round').click(); await page.locator('#next-round').waitFor();
  await page.locator('#next-round').click(); await page.locator('#dismiss-reveal').click(); await page.locator('[data-action="app:calendar"]').first().click(); await page.getByText('2:20 PM – 3:15 PM').waitFor();
  report.checks.push('No initial vendor/weight requests; task completion; draft persistence; profile; replay; fresh variation');
  const mobile=await browser.newPage({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:2}); mobile.on('pageerror',e=>errors.push(e.message));
  await mobile.goto(origin); await mobile.evaluate(()=>document.fonts.ready);
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await mobile.screenshot({path:join(output,'mobile.png'),fullPage:true});
  const reduced = await browser.newPage({viewport:{width:390,height:844},reducedMotion:'reduce'});
  await reduced.goto(origin);
  assert.equal(await reduced.locator('#peek-phone').evaluate(el=>getComputedStyle(el).animationName),'none');
  await reduced.locator('#start-round').focus(); await reduced.keyboard.press('Enter'); await reduced.locator('#dismiss-reveal').waitFor();
  assert.equal(await reduced.locator('#phone').evaluate(el=>el.getAnimations().length),0);
  await reduced.locator('#site-menu summary').focus(); await reduced.keyboard.press('Enter'); await reduced.keyboard.press('Escape');
  assert.equal(await reduced.locator('#site-menu').evaluate(el=>el.open),false); await reduced.close();
  report.checks.push('Keyboard start and menu dismissal; reduced motion skips bounce and expansion');
  await mobile.locator('#start-round').click(); await mobile.locator('#dismiss-reveal').click(); await mobile.screenshot({path:join(output,'mobile-game.png'),fullPage:true}); await mobile.locator('[data-action="app:messages"]').first().click(); await mobile.locator('[data-action="contact:mom"]').click(); await mobile.locator('#phone-reply').fill('5:40 PM, side entrance'); await mobile.getByRole('button',{name:'Send message',exact:true}).click(); await mobile.locator('#next-round').waitFor();
  await mobile.screenshot({path:join(output,'mobile-result.png'),fullPage:true});
  report.checks.push('Mobile layout has no horizontal overflow and can finish a task');
  const compact = await browser.newPage({viewport:{width:320,height:568},isMobile:true});
  compact.on('pageerror', e=>errors.push(e.message));
  await compact.goto(origin);
  assert.equal(await compact.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await compact.locator('#start-round').click(); await compact.locator('#dismiss-reveal').click();
  await compact.locator('#remember').click(); await compact.locator('#task-note-content').getByText('Tell Mom when and where to pick you up.',{exact:true}).waitFor();
  assert.equal(await compact.locator('#phone .task-note').count(),0);
  await compact.screenshot({path:join(output,'compact-game.png'),fullPage:true});
  await compact.close();
  report.checks.push('Small 320px phone can enter the game and recall its intention');
  const policyPage = await browser.newPage(), policyRequests = [];
  policyPage.on('request', request => policyRequests.push(request.url()));
  await policyPage.goto(origin);
  const policyResult = await policyPage.evaluate(async () => {
    const { MeshController } = await import('/muzil/mesh.mjs');
    const controller = new MeshController();
    try {
      await controller.initialize();
      return { base: controller.modelBase, index: controller.indexUrl, ready: controller.ready };
    } finally { await controller.close(); }
  });
  assert.equal(policyResult.base, origin + '/vendor/doppler/models/muzil-gemma-1b/');
  assert.equal(policyResult.index, origin + '/vendor/doppler/models/partition-pieces/gemma-3-1b.json');
  assert.equal(policyResult.ready, false);
  assert.equal(policyRequests.some(url => url.includes('/vendor/doppler/') || /\.bin(?:\?|$)/.test(url)), false);
  report.checks.push('Mesh policy resolves explicit artifact URLs without importing Doppler or acquiring weights');
  await policyPage.close();
  const a=await browser.newPage(),b=await browser.newPage();
  for(const p of [a,b]) {p.on('pageerror',e=>errors.push(e.message));await p.goto(origin); await p.evaluate(async()=>{
    const {PeerController}=await import('/muzil/peer.mjs');
    window.testPeer=new PeerController({local:{session:{},model:'transport-fixture',busy:false,generate:async(job,signal)=>{
      if(job.message==='wait') await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});setTimeout(resolve,15000);});
      return {text:'fixture transport response',model:'transport-fixture'};
    }}});window.testPeer.sharing=true;
  });}
  await a.evaluate(()=>window.testPeer.connect(true)); const offer=await a.evaluate(()=>window.testPeer.exportCode());
  await b.evaluate(()=>window.testPeer.connect(false)); await b.evaluate(c=>window.testPeer.acceptCode(c),offer); const answer=await b.evaluate(()=>window.testPeer.exportCode()); await a.evaluate(c=>window.testPeer.acceptCode(c),answer);
  await a.waitForFunction(()=>window.testPeer.ready);await b.waitForFunction(()=>window.testPeer.ready);
  const result=await a.evaluate(()=>window.testPeer.generate({kind:'reply',message:'hello',context:'fixture'}));assert.equal(result.text,'fixture transport response');
  await a.evaluate(()=>{window.requestOutcome=window.testPeer.generate({kind:'reply',message:'wait',context:'fixture'}).then(()=> 'unexpected success',e=>e.message);});
  await b.waitForFunction(()=>!!window.testPeer.active);await b.evaluate(()=>window.testPeer.close());
  const disconnected=await a.evaluate(()=>window.requestOutcome);assert.match(disconnected,/disconnect|closed/i);
  report.checks.push('Actual two-tab Reploid connection, bounded request/response, active-request disconnect rejection (fixture executor)');
  const player1=await browser.newPage(),player2=await browser.newPage();
  for(const p of [player1,player2]) {await p.addLocatorHandler(p.locator('.interrupting .notification-open'), ()=>handleInterruption(p));p.on('pageerror',e=>errors.push(e.message));await p.goto(origin);await openMenu(p);await p.locator('#race-peer').click();}
  await player1.locator('#make-offer').click();await player1.waitForFunction(()=>document.querySelector('#peer-output').value.startsWith('ey'));
  await player2.locator('#peer-input').fill(await player1.locator('#peer-output').inputValue());await player2.locator('#join-offer').click();await player2.waitForFunction(()=>document.querySelector('#peer-output').value.startsWith('ey'));
  await player1.locator('#peer-input').fill(await player2.locator('#peer-output').inputValue());await player1.locator('#accept-answer').click();
  for(const p of [player1,player2]) {await p.waitForFunction(()=>document.querySelector('#mesh-state').textContent.includes('Peer connected'));await p.locator('#mesh-dialog .close-dialog').click();}
  for(let round=0;round<2;round++) {
    await openMenu(player1);await player1.locator('#race-peer').click();await player2.locator('#accept-race').click();
    for(const p of [player1,player2]) {
      await p.locator('#dismiss-reveal').click();await p.locator('[data-action="app:messages"]').first().click();await p.locator('[data-action="contact:mom"]').click();
      await p.locator('#phone-reply').fill(round===0?'5:40 PM, side entrance':'3:15 PM, garden gate');await p.getByRole('button',{name:'Send message',exact:true}).click();await p.locator('#next-round').waitFor();
    }
    for(const p of [player1,player2]) await p.waitForFunction(()=>document.querySelector('#race-status').textContent.includes('Friendly comparison'));
  }
  report.checks.push('Two real UI peers complete a race and rematch; received outcomes verified through replay');
  const archive=await browser.newPage();await archive.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
  await archive.goto(origin+'/history');await archive.locator('#topnav').waitFor();await archive.getByRole('link',{name:'workshop',exact:true}).waitFor();
  assert.match(await archive.title(),/historical/);report.checks.push('Historical page and original navigation preserved');
  assert.deepEqual(errors,[]);report.errors=errors;report.output=output;
  await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {await browser.close();await new Promise(r=>server.close(r));}
