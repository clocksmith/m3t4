// All mini-app state lives in the replayable phone, including unsaved drafts.
import { calendarEvents } from './challenges.mjs';
const clone = value => structuredClone(value);
export const validTime = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
export function initialDate(scenario) {
  const date = new Date(`${scenario.date}, 2026 12:00:00 GMT`);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0,10) : '2026-09-28';
}
export const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { timeZone:'UTC', weekday:'long', month:'long', day:'numeric' });
export function monthDays(date) {
  const [year,month] = date.split('-').map(Number);
  const count = new Date(Date.UTC(year,month,0)).getUTCDate();
  return Array.from({length:count},(_,i) => `${date.slice(0,7)}-${String(i+1).padStart(2,'0')}`);
}
export function monthShift(date, delta) {
  const [year,month] = date.split('-').map(Number);
  return new Date(Date.UTC(year,month-1+delta,1,12)).toISOString().slice(0,10);
}
export function miniState(scenario, messages) {
  const date = initialDate(scenario);
  return { calendarDate:date, today:date, events:calendarEvents(scenario).map((e,i)=>({...clone(e), id:`event-${i}`, date})), eventDraft:null,
    contacts:(scenario.initial?.contacts || Object.keys(messages).map(id=>({id,name:({mom:'Mom',group:'The group chat'}[id] || id)}))).map(c=>({id:c.id,name:c.name,phone:'',email:''})), personDraft:null,
    extraNotes:[], mainNoteDeleted:false, disabledAlarms:[], alarmEditing:null,
    searches:{messages:'',contacts:'',notes:''} };
}
export const allAlarms = s => [...s.alarms,...s.disabledAlarms].sort();
export const allNotes = s => [...(s.mainNoteDeleted ? [] : [{id:'main',text:s.notes}]),...s.extraNotes];
export const currentNote = s => allNotes(s).find(n=>n.id===(s.screen.noteId || 'main'));
export const noteTitle = n => n.text.trim().split('\n')[0].slice(0,70) || 'Untitled note';
export const matching = (text,query) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
export const shownContacts = s => s.contacts.filter(c=>!c.deleted && matching(`${c.name} ${c.phone} ${c.email}`,s.searches.contacts));
export const shownThreads = s => Object.keys(s.messages).filter(id=>matching(`${s.contacts.find(c=>c.id===id)?.name || id} ${s.messages[id].map(m=>m.text).join(' ')}`,s.searches.messages));
export const shownNotes = s => allNotes(s).filter(n=>matching(n.text,s.searches.notes));
const fields = {
  event:{title:['Event title',100],date:['Event date YYYY-MM-DD',10],start:['Start time HH:MM',5],end:['End time HH:MM',5],note:['Event notes',500]},
  person:{name:['Contact name',100],phone:['Phone number',40],email:['Email address',120]},
};
export function observeMini(s, text, actions, displayTime) {
  const add = (target,label) => actions.push({type:'tap',target,label});
  const type = (target,label,maxLength) => actions.push({type:'type',target,label,maxLength});
  const {app} = s.screen;
  if(Object.hasOwn(s.searches,app)) text.push(`Search: ${s.searches[app]}`);
  const draft = app==='calendar' && s.screen.edit ? 'event' : app==='contacts' && s.screen.edit ? 'person' : null;
  if (draft) {
    const value = s[`${draft}Draft`];
    for (const [key,[label,max]] of Object.entries(fields[draft])) { text.push(`${label}: ${value[key]}`); type(`${draft}-${key}`,label,max); }
    add(`${draft}-save`,'Save changes'); add(`${draft}-cancel`,'Cancel changes'); return;
  }
  if (app==='calendar') {
    const event = s.events.find(e=>e.id===s.screen.eventId);
    if (event) {
      text.push(event.title,dateLabel(event.date),`${displayTime(event.start)}–${displayTime(event.end)}`,event.note);
      add('event-edit','Edit event'); add('event-delete','Delete event'); add('calendar-list','All events');
    } else {
      text.push(dateLabel(s.calendarDate));
      add('month-previous','Previous month'); add('month-next','Next month'); add('calendar-today','Today');
      for (const day of monthDays(s.calendarDate)) add(`day:${day}`,dateLabel(day));
      for (const e of s.events.filter(e=>e.date===s.calendarDate)) { text.push(`${e.title}: ${displayTime(e.start)}–${displayTime(e.end)}`,e.note); add(`event:${e.id}`,`Open ${e.title}`); }
      add('event-new','New event'); if(s.eventDraft) add('event-resume','Resume event draft');
    }
  }
  if (app==='contacts') {
    const person = s.contacts.find(c=>c.id===s.screen.personId && !c.deleted);
    if (person) { text.push(person.name,`Phone: ${person.phone || 'Not set'}`,`Email: ${person.email || 'Not set'}`); add(`contact:${person.id}`,`Message ${person.name}`); add('person-edit','Edit contact'); add('person-delete','Delete contact'); add('contacts-list','All contacts'); }
    else { type('search-contacts','Search contacts',100); for (const c of shownContacts(s)) { text.push(`${c.name}: ${c.phone || c.email || 'View contact'}`); add(`person:${c.id}`,`Open ${c.name}`); add(`contact:${c.id}`,`Message ${c.name}`); } add('person-new','New contact'); if(s.personDraft) add('person-resume','Resume contact draft'); }
  }
  if (app==='clock') {
    for (const time of allAlarms(s)) { text.push(`Alarm: ${time} ${s.alarms.includes(time)?'on':'off'}`); add(`alarm-edit:${time}`,`Edit ${time} alarm`); add(`alarm-toggle:${time}`,`Turn ${time} alarm ${s.alarms.includes(time)?'off':'on'}`); add(`alarm-delete:${time}`,`Delete ${time} alarm`); }
    text.push(`${s.alarmEditing?'Editing':'New'} alarm: ${s.alarmDraft}`); type('alarm','Alarm time HH:MM',5); add('save-alarm',s.alarmEditing?'Save alarm':'Add alarm');
    if(s.alarmEditing) add('alarm-cancel','Cancel alarm changes');
  }
  if(app==='notes') {
    add('note-new','New note');
    const note = !s.screen.list && currentNote(s);
    if(note) { text.push(note.text); type('note','Notes',1000); add('notes-list','All notes'); add('note-delete','Delete note'); }
    else { type('search-notes','Search notes',100); for (const n of shownNotes(s)) add(`note-open:${n.id}`,noteTitle(n)); }
  }
  if(app==='messages' && !s.screen.contact) { type('search-messages','Search messages',100); add('message-new','New message'); }
}
export function validateMini(s, action) {
  const {target,value} = action;
  if(target==='alarm' && value!=='' && !validTime(value)) return 'Use a valid time';
  if(target==='save-alarm' && !validTime(s.alarmDraft)) return 'Choose an alarm time';
  if(target==='save-alarm' && s.alarmEditing && allAlarms(s).some(t=>t===s.alarmDraft && t!==s.alarmEditing)) return 'An alarm already exists at that time';
  if(target==='event-save') {
    const d=s.eventDraft;
    if(!d.title.trim()) return 'Give the event a title';
    if(!validDate(d.date)) return 'Choose a valid date';
    if(!validTime(d.start)||!validTime(d.end)||d.end<=d.start) return 'End time must be after the start time';
  }
  if(target==='person-save') {
    if(!s.personDraft.name.trim()) return 'Give the contact a name';
    if(s.personDraft.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.personDraft.email)) return 'Enter a valid email address';
  }
  return null;
}
// Called only after observe() has authorized the specific control and context.
export function actMini(s, action, visit) {
  const {target,value}=action;
  if(target.startsWith('search-')) s.searches[target.slice(7)] = value;
  else if(target.startsWith('day:')) s.calendarDate=target.slice(4);
  else if(target==='month-previous'||target==='month-next') s.calendarDate=monthShift(s.calendarDate,target==='month-next'?1:-1);
  else if(target==='calendar-today') s.calendarDate=s.today;
  else if(target==='calendar-list') s.screen={app:'calendar'};
  else if(target.startsWith('event:')) visit(s,{app:'calendar',eventId:target.slice(6)});
  else if(target==='event-resume') visit(s,{app:'calendar',edit:true});
  else if(target==='event-new'||target==='event-edit') {
    s.eventDraft=target==='event-edit'?clone(s.events.find(e=>e.id===s.screen.eventId)):{id:`event-new-${s.revision}`,title:'',date:s.calendarDate,start:'09:00',end:'10:00',note:''};
    visit(s,{app:'calendar',edit:true});
  } else if(target==='event-save') {
    const d={...s.eventDraft,title:s.eventDraft.title.trim()};s.events=s.events.filter(e=>e.id!==d.id);s.events.push(d);s.events.sort((a,b)=>a.date.localeCompare(b.date)||a.start.localeCompare(b.start));
    s.calendarDate=d.date;s.screen={app:'calendar',eventId:d.id};s.eventDraft=null;
  } else if(target==='event-cancel') {s.eventDraft=null;s.screen=s.stack.pop()||{app:'calendar'};}
  else if(target==='event-delete') {s.events=s.events.filter(e=>e.id!==s.screen.eventId);if(s.eventDraft?.id===s.screen.eventId)s.eventDraft=null;s.screen={app:'calendar'};}
  else if(target.startsWith('event-')) s.eventDraft[target.slice(6)]=value;
  else if(target==='contacts-list'||target==='message-new') visit(s,{app:'contacts'});
  else if(target.startsWith('person:')) visit(s,{app:'contacts',personId:target.slice(7)});
  else if(target==='person-resume') visit(s,{app:'contacts',edit:true});
  else if(target==='person-new'||target==='person-edit') {
    s.personDraft=target==='person-edit'?clone(s.contacts.find(c=>c.id===s.screen.personId)):{id:`person-${s.revision}`,name:'',phone:'',email:''};
    if(target==='person-new') while(s.contacts.some(c=>c.id===s.personDraft.id)) s.personDraft.id+='-new';
    visit(s,{app:'contacts',edit:true});
  } else if(target==='person-save') {
    const d={...s.personDraft,name:s.personDraft.name.trim()};s.contacts=s.contacts.filter(c=>c.id!==d.id);s.contacts.push(d);s.messages[d.id]||=[];s.drafts[d.id]||='';s.personDraft=null;s.screen={app:'contacts',personId:d.id};
  } else if(target==='person-cancel') {s.personDraft=null;s.screen=s.stack.pop()||{app:'contacts'};}
  else if(target==='person-delete') {s.contacts.find(c=>c.id===s.screen.personId).deleted=true;if(s.personDraft?.id===s.screen.personId)s.personDraft=null;s.screen={app:'contacts'};}
  else if(target.startsWith('person-')) s.personDraft[target.slice(7)]=value;
  else if(target==='notes-list') visit(s,{app:'notes',list:true});
  else if(target.startsWith('note-open:')) visit(s,{app:'notes',noteId:target.slice(10)});
  else if(target==='note-new') { const id=`note-${s.revision}`;s.extraNotes.push({id,text:''});visit(s,{app:'notes',noteId:id}); }
  else if(target==='note-delete') {const id=s.screen.noteId||'main';if(id==='main'){s.mainNoteDeleted=true;s.notes='';}else s.extraNotes=s.extraNotes.filter(n=>n.id!==id);s.screen={app:'notes',list:true};}
  else if(target==='note') {const id=s.screen.noteId||'main';if(id==='main')s.notes=value;else s.extraNotes.find(n=>n.id===id).text=value;}
  else if(target==='alarm') s.alarmDraft=value;
  else if(target==='save-alarm') {
    if(!s.alarmEditing && s.alarms.includes(s.alarmDraft)) return true;
    const enabled=!s.alarmEditing||s.alarms.includes(s.alarmEditing);
    s.alarms=s.alarms.filter(t=>t!==s.alarmEditing);s.disabledAlarms=s.disabledAlarms.filter(t=>t!==s.alarmEditing&&t!==s.alarmDraft);
    (enabled?s.alarms:s.disabledAlarms).push(s.alarmDraft);s.alarmEditing=null;
  } else if(target.startsWith('alarm-edit:')) {s.alarmEditing=target.slice(11);s.alarmDraft=s.alarmEditing;}
  else if(target.startsWith('alarm-toggle:')) { const time=target.slice(13),enabled=s.alarms.includes(time);s.alarms=s.alarms.filter(t=>t!==time);s.disabledAlarms=s.disabledAlarms.filter(t=>t!==time);(enabled?s.disabledAlarms:s.alarms).push(time); }
  else if(target.startsWith('alarm-delete:')) {const time=target.slice(13);s.alarms=s.alarms.filter(t=>t!==time);s.disabledAlarms=s.disabledAlarms.filter(t=>t!==time);if(s.alarmEditing===time)s.alarmEditing=null;}
  else if(target==='alarm-cancel') {s.alarmEditing=null;s.alarmDraft='07:00';}
  else return false;
  return true;
}

export function cleanMiniNavigation(s) {
  const valid = screen => !(screen.edit && ((screen.app==='calendar'&&!s.eventDraft)||(screen.app==='contacts'&&!s.personDraft)))
    && !(screen.eventId && !s.events.some(e=>e.id===screen.eventId))
    && !(screen.personId && !s.contacts.some(c=>c.id===screen.personId&&!c.deleted))
    && !(screen.noteId && !allNotes(s).some(n=>n.id===screen.noteId));
  s.stack = s.stack.filter(valid);
  if(!valid(s.screen)) s.screen={app:s.screen.app};
}
