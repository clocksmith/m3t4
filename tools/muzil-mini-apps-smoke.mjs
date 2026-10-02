import { followDetour } from './muzil-smoke-actions.mjs';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDevServer } from './dev-serve.mjs';
const server=createDevServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,output=await mkdtemp(join(tmpdir(),'muzil-mini-apps-'));
const browser=await chromium.launch({channel:'chrome',headless:true}),errors=[],checks=[];
try {
 for(const width of [1440,390,320]) {
  const page=await browser.newPage({viewport:{width,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date('2026-09-30T12:00:00Z')});await page.goto(origin);await page.locator('#start-round:not(:disabled)').waitFor({state:'attached'});await page.locator('#challenge-select').evaluate((el,value)=>el.value=value,'pickup-errands');await page.clock.pauseAt(new Date('2026-09-30T12:00:01Z'));
  const tap=target=>page.locator(`[data-action="${target}"]`).first().click();
  const app=async name=>{await page.locator('#phone-home').click();await tap(`app:${name}`);};
  const field=(target,value)=>page.locator(`[data-field="${target}"]`).fill(value);
  const shot=async name=>{
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   assert.equal(await page.locator('#phone-screen').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
   await page.screenshot({path:join(output,`${name}-${width}.png`),fullPage:true});
  };
  await page.locator('#start-round').click();await page.locator('#dismiss-reveal').click();
  await app('calendar');await tap('month-next');await page.getByText('October 2026',{exact:true}).waitFor();await tap('calendar-today');await tap('day:2026-09-29');await page.getByText('No events on this day.').waitFor();await tap('calendar-today');await shot('calendar');
  await tap('event:event-0');await tap('event-edit');await field('event-title','Dentist updated');await field('event-note','Bring the card');await shot('event-editor');await tap('event-save');await page.locator('.event-note').getByText('Bring the card').waitFor();
  await app('calendar');await tap('event-new');await field('event-title','Lunch with Ada');await field('event-date','2026-10-02');await field('event-start','12:00');await field('event-end','12:30');
  await app('calendar');await tap('event-resume');assert.equal(await page.getByLabel('Event title',{exact:true}).inputValue(),'Lunch with Ada');
  await page.clock.runFor(7200);await page.locator('.interrupting .notification-open').click();await followDetour(page);await app('calendar');await tap('event-resume');assert.equal(await page.getByLabel('Event title',{exact:true}).inputValue(),'Lunch with Ada');await tap('event-save');await tap('event-delete');await page.getByText('No events on this day.').waitFor();
  await app('clock');await field('alarm','');await tap('save-alarm');await page.locator('#toast').getByText('Choose an alarm time').waitFor();await field('alarm','08:00');await tap('save-alarm');await tap('alarm-toggle:08:00');assert.equal(await page.getByRole('switch',{name:'08:00 alarm'}).getAttribute('aria-checked'),'false');await tap('alarm-edit:08:00');await field('alarm','08:15');await tap('save-alarm');await tap('alarm-toggle:08:15');await shot('clock');await app('clock');assert.equal(await page.getByRole('switch',{name:'08:15 alarm'}).getAttribute('aria-checked'),'true');await tap('alarm-delete:08:15');
  await app('notes');const original=await page.getByLabel('Notes',{exact:true}).inputValue();await tap('note-new');await field('note','Weekend plan\nWalk by the river');await app('notes');assert.equal(await page.getByLabel('Notes',{exact:true}).inputValue(),original);await tap('notes-list');await field('search-notes','Weekend');await shot('notes');await page.getByRole('button',{name:'Weekend plan Walk by the river'}).click();await field('note','Weekend plan\nWalk with Ada');await tap('note-delete');await field('search-notes','');await page.getByRole('button',{name:/Dentist · pickup/}).click();assert.equal(await page.getByLabel('Notes',{exact:true}).inputValue(),original);
  await app('messages');await tap('message-new');await tap('person-new');await field('person-name','Ada');await field('person-phone','555-0100');await field('person-email','ada@example.test');await tap('person-save');await shot('contact');await tap('person-edit');await field('person-name','Ada Lovelace');await tap('person-save');await page.getByRole('button',{name:'Message',exact:true}).click();await field('reply','Hello from the simulator');await page.getByRole('button',{name:'Send message',exact:true}).click();await app('messages');await field('search-messages','Hello from');await page.getByRole('button',{name:/Ada Lovelace Hello/}).click();await page.locator('.bubble.outgoing').getByText('Hello from the simulator').waitFor();
  await app('contacts');await field('search-contacts','Ada');await page.getByRole('button',{name:/Ada Lovelace 555/}).click();await tap('person-delete');await page.getByText('No contacts found.').waitFor();
  await app('messages');await field('search-messages','Mom');await tap('contact:mom');await field('reply','5:40 PM, side entrance');await page.getByRole('button',{name:'Send message',exact:true}).click();await page.locator('#next-round').waitFor();
  const replayCheck=await page.evaluate(async()=>{const {replay}=await import('/muzil/engine.mjs');const s=replay(JSON.parse(localStorage.getItem('muzil.replay.v1')));return {phase:s.phase,events:s.events,alarms:s.alarms,extraNotes:s.extraNotes,ada:s.contacts.find(c=>c.name==='Ada Lovelace')};});
  assert.equal(replayCheck.phase,'finished');assert.equal(replayCheck.events[0].title,'Dentist updated');assert.deepEqual(replayCheck.alarms,[]);assert.deepEqual(replayCheck.extraNotes,[]);assert.equal(replayCheck.ada.deleted,true);
  checks.push(`${width}px: Calendar date navigation and event CRUD, interrupted draft recovery, alarm edit/toggle/delete, notes CRUD/search, contacts CRUD and new conversations, message search/send, completed replay, no overflow`);
  await page.close();
 }
 assert.deepEqual(errors,[]);const report={output,checks,errors};await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}catch(error){console.error(error);throw error;}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
