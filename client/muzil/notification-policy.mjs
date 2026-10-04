// Policies travel with the scenario/replay. Missing policy data keeps historical rules.
export const configuredNotifications = s => !!s.scenario.notificationPolicies;
const verbs = new Set(['open','expand','dismiss','defer','answer','decline','read','later','none']);
const entries = new Set(['open','answer','decline','read']);
export function notificationPolicy(s, n) {
  const c = s.scenario;
  if (!c.notificationPolicies) {
    const mandatory = s.version !== 'muzil-phone/1' && c.version >= 1;
    return { blocksPhone:mandatory || !!n.interruptive, requireOpen:mandatory, requireResolution:mandatory,
      gestures:{tap:'open'}, controls:mandatory?['open']:['open','dismiss'] };
  }
  const override = c.notificationOverrides?.[n.id] || {};
  const name = override.policy || n.policy || c.notificationDefaults.policy;
  return {...c.notificationDefaults,...c.notificationPolicies[name],...n,...override};
}
export function notificationTarget(id, verb) { return verb === 'open' ? `notification:${id}` : `notice:${id}:${verb}`; }
export function notificationActions(s, n) {
  const p = notificationPolicy(s,n);
  const labels = {open:'Open',expand:'Expand',dismiss:'Dismiss',defer:'Later',answer:'Answer',decline:'Decline and read voicemail',read:'Read',later:'Later'};
  // Every gesture has an equivalent visible/keyboard control.
  if(!configuredNotifications(s))return p.controls.map(v=>({type:'tap',target:v==='open'?`notification:${n.id}`:`dismiss:${n.id}`,label:v==='open'?`Open ${n.title}`:`Dismiss ${n.title}`}));
  return [...new Set([...p.controls,...Object.values(p.gestures)])].filter(v=>v!=='none').map(v=>({type:'tap',target:notificationTarget(n.id,v),label:labels[v]}));
}
export function notificationGesture(s,n,gesture) {
  const verb=notificationPolicy(s,n).gestures[gesture];
  return verb && verb!=='none' ? notificationTarget(n.id,verb) : null;
}
export function validateNotificationConfig(c) {
  if (!c.notificationPolicies) {
    if(c.notificationDefaults || c.notificationOverrides) throw new Error('Invalid challenge: notification policies are missing');
    return;
  }
  const check=(ok,message)=>{if(!ok)throw new Error(`Invalid challenge: ${message}`);};
  const object=x=>x && typeof x==='object' && !Array.isArray(x);
  const bounded=(x,min,max)=>Number.isInteger(x)&&x>=min&&x<=max;
  check(c.version===2,'notification policies require an evolving (version 2) scenario');
  check(object(c.notificationPolicies)&&Object.keys(c.notificationPolicies).length>0,'notification policies');
  const d=c.notificationDefaults;
  check(object(d)&&Object.hasOwn(c.notificationPolicies,d.policy),'default notification policy');
  check(bounded(d.quietAfterResolutionMs,0,30000),'notification quiet window');
  check(bounded(d.maxSimultaneousBlocking,1,3)&&bounded(d.maxPending,1,12),'notification backlog limits');
  check(bounded(d.maxEventsPerEpisode,1,10),'episode recurrence limit');
  check(object(d.gestureThresholds)&&bounded(d.gestureThresholds.distancePx,16,160)&&bounded(d.gestureThresholds.axisRatio,1,3),'gesture thresholds');
  check(typeof d.sound==='boolean','notification sound');
  check(!c.notificationOverrides || object(c.notificationOverrides),'notification overrides');
  const all=[...c.interruptions,...(c.followups||[])];
  for(const id of Object.keys(c.notificationOverrides||{}))check(all.some(n=>n.id===id),'unknown notification override');
  const validate=(p,n)=>{
    for(const k of ['blocksPhone','requireOpen','requireResolution'])check(typeof p[k]==='boolean',`notification ${k}`);
    check(object(p.gestures)&&Object.keys(p.gestures).every(k=>['tap','swipeDown','swipeUp','swipeLeft','swipeRight'].includes(k))&&Object.values(p.gestures).every(v=>verbs.has(v)),'notification gestures');
    check(Array.isArray(p.controls)&&p.controls.every(v=>verbs.has(v)&&v!=='none'),'notification controls');
    const available=[...p.controls,...Object.values(p.gestures)];
    check(available.some(v=>entries.has(v)),'notification needs a reachable opening action');
    check(!p.requireOpen || p.blocksPhone && !available.some(v=>['dismiss','defer','later'].includes(v)),'required opening cannot be dismissed');
    check(!p.requireResolution || !n || n.interaction || n.distraction,'resolution requires an interaction');
    check(!n || !available.some(v=>['answer','decline'].includes(v)) || n.interaction==='call','call choices require a call');
    check(bounded(p.quietAfterResolutionMs,0,30000)&&typeof p.sound==='boolean','notification timing or sound');
    check(object(p.gestureThresholds)&&bounded(p.gestureThresholds.distancePx,16,160)&&bounded(p.gestureThresholds.axisRatio,1,3),'gesture thresholds');
    if(n){
      check(['incoming-call','message','calendar-update','video','system-sheet'].includes(p.presentation),'notification presentation');
      check(['task-update','useful-information','unrelated-detour','mixed'].includes(p.classification),'notification classification');
      if(p.resolutionTimingMs)check(object(p.resolutionTimingMs)&&Object.keys(p.resolutionTimingMs).every(k=>['answer','voicemail','miss','longExit'].includes(k))&&Object.values(p.resolutionTimingMs).every(v=>bounded(v,0,15000)),'resolution timing');
    }
  };
  for(const p of Object.values(c.notificationPolicies))validate({...d,...p});
  for(const n of all){
    const name=c.notificationOverrides?.[n.id]?.policy || n.policy || d.policy;
    check(Object.hasOwn(c.notificationPolicies,name),'unknown notification policy');
    validate(notificationPolicy({scenario:c},n),n);
  }
}
export function accountNotificationTime(s,n,ms) {
  if(!s.metrics || ms<=0)return;
  s.metrics.interruptionMs+=ms;
  if(!configuredNotifications(s))return;
  const kind=notificationPolicy(s,n).classification;
  const key=kind==='task-update'||kind==='useful-information'?'taskUpdateMs':kind==='unrelated-detour'?'detourMs':'mixedMs';
  s.metrics[key]=(s.metrics[key]||0)+ms;
}
