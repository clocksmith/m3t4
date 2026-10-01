import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPhone, applyAction, observe, advance, replay, makeReplay } from '../engine.mjs';
import { allNotes, monthShift, validDate } from '../mini-apps.mjs';
const catalog=JSON.parse(await readFile(new URL('../challenges.json',import.meta.url))).challenges;
let serial=0;
function act(s,target,value) {const r=applyAction(s,{roundId:s.roundId,id:`test-${++serial}`,screen:structuredClone(s.screen),type:value===undefined?'tap':'type',target,...(value===undefined?{}:{value})});assert.equal(r.accepted,true,`${target}: ${r.reason}`);return r.state;}
function reject(s,target,value) {const r=applyAction(s,{roundId:s.roundId,id:`test-${++serial}`,type:value===undefined?'tap':'type',target,value});assert.equal(r.accepted,false);assert.equal(r.state,s);}
const start=(index=0)=>act(createPhone({roundId:'mini-app-test',scenario:catalog[index]}),'start');
const app=(s,name)=>act(act(s,'home'),`app:${name}`);
function identical(s) {const r=replay(makeReplay(s));assert.deepEqual(r,s);}
test('Calendar browses days and months, edits and deletes events without changing challenge truth',()=>{
 let s=app(start(),'calendar');s=act(s,'month-next');assert.equal(s.calendarDate,'2026-10-01');s=act(s,'month-previous');s=act(s,'calendar-today');
 s=act(s,'event:event-0');s=act(s,'event-edit');s=act(s,'event-title','Changed dentist');s=act(s,'event-end','18:00');s=act(s,'event-save');
 assert.equal(s.events[0].end,'18:00');assert.equal(s.scenario.initial.calendar[0].end,'17:40');
 s=app(s,'calendar');assert.ok(observe(s).text.some(t=>t.includes('6:00 PM')));s=act(s,'event:event-0');s=act(s,'event-delete');s=act(s,'back');assert.ok(!s.screen.eventId);assert.equal(s.events.length,0);identical(s);
});
test('event drafts survive navigation and forceful interruptions; invalid dates and times cannot save',()=>{
 let s=app(start(),'calendar');s=act(s,'event-new');reject(s,'event-save');s=act(s,'event-title','Lunch');s=act(s,'event-date','2026-02-30');reject(s,'event-save');s=act(s,'event-date','2026-10-02');s=act(s,'event-end','08:00');reject(s,'event-save');s=act(s,'event-end','10:30');
 s=advance(s,7200);reject(s,'event-save');s=act(s,'notification:group-urgent');for(let i=0;i<3;i++)s=act(s,`bait:tile:${i}`);s=act(s,'bait:replies');s=act(s,'bait:react:laugh');s=act(s,'bait:source');assert.equal(s.screen.app,'feed');assert.equal(s.eventDraft.title,'Lunch');
 s=app(s,'calendar');s=act(s,'event-resume');s=act(s,'event-save');assert.equal(s.calendarDate,'2026-10-02');s=act(s,'back');assert.ok(!s.screen.edit);identical(s);
 assert.equal(monthShift('2026-12-31',1),'2027-01-01');assert.equal(validDate('2026-02-29'),false);assert.equal(validDate('2028-02-29'),true);
});
test('alarms can be edited, disabled, enabled and deleted; replay keeps enabled state',()=>{
 let s=app(start(),'clock');s=act(s,'alarm','');reject(s,'save-alarm');s=act(s,'alarm','08:00');s=act(s,'save-alarm');s=act(s,'save-alarm');assert.deepEqual(s.alarms,['08:00']);
 s=act(s,'alarm-toggle:08:00');assert.deepEqual(s.alarms,[]);s=act(s,'alarm-edit:08:00');s=act(s,'alarm','08:15');s=act(s,'save-alarm');assert.deepEqual(s.disabledAlarms,['08:15']);
 s=act(s,'alarm-toggle:08:15');s=app(s,'clock');assert.deepEqual(s.alarms,['08:15']);s=act(s,'alarm','09:00');s=act(s,'save-alarm');s=act(s,'alarm-edit:08:15');s=act(s,'alarm','09:00');reject(s,'save-alarm');s=act(s,'alarm-cancel');s=act(s,'alarm-delete:09:00');s=act(s,'alarm-delete:08:15');reject(s,'alarm','25:00');identical(s);
});
test('note creation, search, editing and deletion preserve the original task note',()=>{
 let s=app(start(),'notes');const original=s.notes;s=act(s,'note-new');const id=s.screen.noteId;s=act(s,'note','My second note\nWith details');s=app(s,'notes');assert.equal(s.notes,original);s=act(s,'notes-list');s=act(s,'search-notes','second');assert.ok(observe(s).actions.some(a=>a.target===`note-open:${id}`));reject(s,'note-open:main');s=act(s,`note-open:${id}`);s=act(s,'note','Edited note');s=act(s,'note-delete');s=act(s,'search-notes','');s=act(s,'note-open:main');s=act(s,'note-delete');s=act(s,'back');assert.equal(allNotes(s).length,0);reject(s,'note','Cannot edit a deleted note');identical(s);
});
test('a task can be completed in a newly created note, not by deleting its required content',()=>{
 const i=catalog.findIndex(c=>c.id==='grocery-detour');let s=app(start(i),'notes');s=act(s,'note-delete');assert.equal(s.phase,'playing');s=act(s,'note-new');s=act(s,'note','soap lemons rice coffee');assert.equal(s.phase,'finished');identical(s);
});
test('contacts have editable details, searchable names and new working conversations',()=>{
 let s=app(start(),'contacts');s=act(s,'person-new');reject(s,'person-save');s=act(s,'person-name','Ada');s=act(s,'person-email','invalid');reject(s,'person-save');s=act(s,'person-email','ada@example.test');s=act(s,'person-phone','555-0100');s=app(s,'contacts');s=act(s,'person-resume');s=act(s,'person-save');const id=s.screen.personId;
 s=act(s,`contact:${id}`);s=act(s,'reply','Hello Ada');s=act(s,'send');assert.equal(s.messages[id][0].text,'Hello Ada');s=app(s,'messages');s=act(s,'search-messages','Hello');assert.ok(observe(s).actions.some(a=>a.target===`contact:${id}`));reject(s,'contact:mom');
 s=app(s,'contacts');s=act(s,'search-contacts','ada');s=act(s,`person:${id}`);s=act(s,'person-edit');s=act(s,'person-name','Ada Lovelace');s=act(s,'person-save');s=act(s,'person-delete');s=act(s,'back');assert.ok(!s.screen.personId);s=app(s,'messages');s=act(s,`contact:${id}`);assert.equal(s.messages[id].length,1);identical(s);
});
test('stale detail actions and draft controls cannot change a different screen',()=>{
 let s=app(start(),'calendar');s=act(s,'event:event-0');const screen=structuredClone(s.screen);s=act(s,'calendar-list');const r=applyAction(s,{roundId:s.roundId,id:'stale',type:'tap',target:'event-delete',screen});assert.equal(r.accepted,false);reject(s,'event-title','Injected');s=app(s,'contacts');reject(s,'person-name','Injected');identical(s);
});
