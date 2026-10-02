import { validateChallenge } from './challenges.mjs';
export const FAMILIES = ['coordinate','prepare','repair'];
export function seeded(seed) {
  let h=2166136261; for(const c of String(seed))h=Math.imul(h^c.charCodeAt(0),16777619)>>>0;
  return () => {h=(Math.imul(h,1664525)+1013904223)>>>0;return h/4294967296;};
}
const time = minutes => `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
export function generateChallenge(template, seed) {
  const random=seeded(seed), pick=xs=>xs[Math.floor(random()*xs.length)];
  const family=template.family;
  if(!FAMILIES.includes(family))throw new Error('Unknown task family');
  const recoveryReduction={coordinate:0,prepare:1000,repair:2000}[family];
  const pressure=template.pressure || {minimumGapMs:2500,recoveryMs:Object.fromEntries(Object.entries({message:8000,call:7000,group:6000,conflict:8000,timing:5000,media:6000}).map(([kind,ms])=>[kind,ms-recoveryReduction]))};
  const parent=pick(['Mom','Aunt Jo','Maya']), driver=pick(['Dad','Alex','Sam']);
  const places=['north entrance','garden entrance','side entrance'], oldPlace=pick(places), place=pick(places.filter(p=>p!==oldPlace));
  const start=14*60+Math.floor(random()*12)*10, oldEnd=time(start+40), end=time(start+65), alarm=time(start+55);
  const messageGoal=(who,when,where)=>({kind:'message',contact:who,time:when,choice:{options:places,expected:where}});
  const goalFor=(who,when,where,needsAlarm=false)=> family==='coordinate' && !needsAlarm ? messageGoal(who,when,where) : {all:[messageGoal(who,when,where),{kind:'alarm',time:needsAlarm?alarm:time(Number(when.slice(0,2))*60+Number(when.slice(3))-10)},...(family==='prepare'?[{kind:'note',includes:[where]}]:[]),...(family==='repair'&&when!==oldEnd?[{kind:'alarm',time:time(start+30),absent:true}]:[])]};
  const event={title:pick(['Dentist','Eye appointment','Bike fitting']),start:time(start),end:oldEnd,note:`Pickup at the ${oldPlace}.`};
  const notification=(id,at,app,title,body,extra={})=>({id,episode:'pickup',at,app,title,body,...extra});
  const c={version:2,id:`changing-${family}`,family,seed:String(seed),title:{coordinate:'Coordinate a pickup',prepare:'Prepare to leave',repair:'Repair the plan'}[family],
    intention:family==='coordinate'?`Arrange your pickup after the appointment.`:family==='prepare'?`Save the pickup entrance, set a reminder ten minutes before pickup, and confirm with your driver.`:`Correct your pickup reminder, remove the old alarm, and confirm with your driver.`,
    success:'Your driver has the current plan.',date:'Monday, September 28',durationMs:180000,
    initial:{contacts:[{id:'parent',name:parent,messages:[`I’m collecting you. Send me the finish time and entrance when you know.`]},{id:'driver',name:driver,messages:['Let me know if you need a lift.']},{id:'reception',name:'Reception',messages:[`Pickup is at the ${oldPlace}. Calendar has the finish time.`]},{id:'group',name:'The group chat',messages:['We are deciding where to go after. Can you come?']}],calendar:[event],notes:`Pickup: ${oldPlace}. Allow ten minutes to get ready.`,alarms:family==='repair'?[time(start+30)]:[]},
    goal:goalFor('parent',oldEnd,oldPlace),
    pressure:structuredClone(pressure),
    interruptions:[]};
  c.interruptions=[
    notification('finish-changed',6500,'calendar','Appointment updated',`${event.title} now finishes at ${end}. The old finish time was ${oldEnd}.`,{trigger:'calendar-left',delayMs:0,interaction:'conflict',detail:`Clinic update: pickup is now ${end}, at the ${oldPlace}.`,effects:{facts:{finish:end},calendar:{index:0,event:{...event,end,note:`Clinic update: finishes at ${end}. Pickup at the ${oldPlace}.`}},goal:goalFor('parent',end,oldPlace)}}),
    notification('driver-changed',22000,'messages',parent,`${driver} is collecting you instead. Please send the plan to ${driver}.`,{after:'finish-changed',trigger:'draft-started',delayMs:1000,contact:'parent',effects:{facts:{driver:'driver'},goal:goalFor('driver',end,oldPlace)}}),
    notification('entrance-changed',40000,'messages','Reception is calling','There has been a change to pickup.',{after:'driver-changed',contact:'reception',interaction:'call',detail:`Pickup has moved to the ${place}. The finish time is still ${end}.`,voicemail:`The old entrance is closed. Check our latest message for the replacement.`,effects:{facts:{entrance:place},messages:[{contact:'reception',text:`Pickup moved to the ${place}; ${oldPlace} is closed. Finish time: ${end}.`}],goal:goalFor('driver',end,place)}}),
    notification('group-plan',55000,'messages','The group chat','Are you coming with us, or arranging your pickup?',{contact:'group',episode:'group-plan',trigger:'fact-read',delayMs:25000,interaction:'group',detail:'They need a definite answer before reserving a table.'}),
    notification('reminder-request',76000,'messages',driver,`Set a reminder for ${alarm} before you leave, then send me the pickup time and entrance.`,{after:'entrance-changed',contact:'driver',effects:{facts:{alarm},goal:goalFor('driver',end,place,true)}}),
    notification('timing-invite',98000,'feed','One perfect tap','Stop in the green zone to get out quickly. Or take the longer exit.',{episode:'timing',interaction:'timing',distraction:'timing'}),
    notification('photo-tag',125000,'feed','Someone tagged you','A pigeon has your exact expression. Three tiles. Then you can leave.',{episode:'photo',interaction:'media',distraction:'reveal'}),
  ];
  // A legitimate follow-up in one episode; only a vague/postponed response arms it.
  // Some clinics update Calendar; others only send a message. The editable copy
  // may stay obsolete, while the external requirement is the same communicated fact.
  if(random()<0.5) {
    const update=c.interruptions[0];update.app='messages';update.contact='reception';
    update.body+=` Pickup at the ${oldPlace}. Your Calendar copy has not synced.`;
    update.detail+=' Calendar still shows the previous time; inspect the clinic message.';
    delete update.effects.calendar;
  }
  if(random()<0.5)c.initial.notes='Pickup: check the latest Reception message for the entrance. Allow ten minutes to get ready.';
  c.followups=[notification('group-clarify',179000,'messages','The group chat','We still need a yes or no. Are you joining us?',{contact:'group',episode:'group-plan',interaction:'group',followup:true,delayMs:12000,detail:'One definite answer will close this thread.'})];
  return validateChallenge(c);
}
