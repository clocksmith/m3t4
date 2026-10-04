import { configuredNotifications, notificationPolicy, notificationActions, accountNotificationTime } from './notification-policy.mjs';
import { directed, signal, deliverNext, recovery } from './notification-director.mjs';
import { newDistraction, distractionObservation, actOnDistraction, decisionDistraction, actOnDecision } from './distractions.mjs';
import { RULES, SCENARIOS, APPS } from './scenarios.mjs';
import { evaluateGoal, contactName, roundDuration, validateChallenge } from './challenges.mjs';
import { miniState, observeMini, validateMini, actMini, shownThreads, cleanMiniNavigation } from './mini-apps.mjs';
import { doomPost } from './doom-content.mjs';
const copy = x => structuredClone(x);
export function createPhone({ roundId, scenario = SCENARIOS[0], controller = 'human', version = RULES.version }) {
  if (!roundId) throw new Error('A round identity is required');
  if(scenario.version===2 && version!=='muzil-phone/3')throw new Error('Evolving challenges require phone rules v3');
  if (scenario.version >= 1) scenario = validateChallenge(scenario);
  const messages = scenario.initial ? Object.fromEntries(scenario.initial.contacts.map(c => [c.id, c.messages.map(text => ({ from:c.id, text }))])) : { mom: [{ from: 'mom', text: scenario.incoming }], group: [{ from: 'group', text: 'Would you rather fight one horse-sized duck or finish your errands?' }] };
  return { version, roundId, scenario: copy(scenario), controller, phase: 'ready', elapsed: 0,
    ...(scenario.version===2 ? {external:{goal:copy(scenario.goal),facts:{},revision:0},director:{signals:{},events:[],nextAt:0,followups:[]},metrics:{interruptionMs:0,oldCalendarChecks:0,mistakes:0}} : {}), ...(scenario.notificationPolicies ? {notificationHistory:[]} : {}), semanticActions:0, editEvents:0,
    ...miniState(scenario, messages), screen: { app: 'home' }, stack: [], revision: 0, notifications: [], delivered: [], seen: [], resolvedNotifications:[], notificationQuietUntil:0,
    messages, drafts: Object.fromEntries(Object.keys(messages).map(id => [id, ''])), notes: scenario.initial?.notes ?? scenario.initialNotes ?? '', alarms: copy(scenario.initial?.alarms || []), alarmDraft: '07:00', feedIndex: 0, feedLikes: [], distractions: {}, distractionTaps: 0, sent: [], log: [], demonstrations: [], recalled: 0 };
}
function armFollowup(s,n) {
  if(!directed(s))return;
  for(const followup of s.scenario.followups || [])if(followup.episode===n.episode && !s.director.followups.some(event=>event.id===followup.id))s.director.followups.push({...copy(followup),at:s.elapsed+(configuredNotifications(s)?(followup.delayMs ?? 12000):(followup.delayMs || 12000))});
}
function recordNotice(s,n,consequence) {
  if(!s.notificationHistory)return;
  const existing=s.notificationHistory.find(e=>e.id===n.id);
  const entry={...copy(n),consequence,handledAt:s.elapsed};
  if(existing)Object.assign(existing,entry);else s.notificationHistory.push(entry);
}
export const mandatoryNotifications = s => s.version !== 'muzil-phone/1' && s.scenario.version >= 1;
export const lockedDistraction = s => s.phase === 'playing' && s.screen.app === 'distraction' && s.distractions[s.screen.distractionId]?.required;
const notificationKey = n => JSON.stringify([n.title,n.body,n.distraction || null]);
export const blockingNotification = s => s.phase === 'playing' && !lockedDistraction(s) && (configuredNotifications(s) || !mandatoryNotifications(s) || s.elapsed >= s.notificationQuietUntil) ? s.notifications.find(n => n.at<=s.elapsed && notificationPolicy(s,n).blocksPhone) : null;
export function taskThoughtVisible(s) {
  if (s.phase !== 'playing') return false;
  if (s.elapsed < (s.taskRecallUntil || 0)) return true;
  if (s.version === 'muzil-phone/3') return s.elapsed % (RULES.revealMs + RULES.hiddenMs) < RULES.revealMs;
  return s.elapsed < RULES.revealMs;
}
function visit(s, screen) { s.stack.push(copy(s.screen)); s.screen = screen; }
export function outcome(s) {
  if (s.scenario.goal) return evaluateGoal(s.external?.goal || s.scenario.goal, s);
  const correct = timeMinutes(s.scenario.end);
  if (s.scenario.requiredAlarm && !s.alarms.includes(s.scenario.requiredAlarm)) return false;
  const messages = s.scenario.location ? s.sent.filter(m => m.contact === s.scenario.contact).slice(-1) : s.sent;
  return messages.some(m => m.contact === s.scenario.contact && (() => {
    if (s.scenario.location) {
      const text = ` ${m.text.toLowerCase().replace(/[^a-z]+/g, ' ')} `;
      const entrances = (s.scenario.entrances || [s.scenario.location]).filter(place => text.includes(` ${place} `));
      if (entrances.length !== 1 || entrances[0] !== s.scenario.location) return false;
    }
    const times = [...m.text.matchAll(/\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/gi)];
    return times.length === 1 && timeMinutes(`${times[0][1]}:${times[0][2]}`, times[0][3], correct) === correct;
  })());
}
function timeMinutes(text, suffix = '', reference = null) {
  let [h, m] = text.split(':').map(Number);
  if (h > 23 || m > 59) return -1;
  if (/p/i.test(suffix) && h < 12) h += 12;
  if (/a/i.test(suffix) && h === 12) h = 0;
  if (!suffix && reference !== null && h < 12 && reference >= 720) h += 12;
  return h * 60 + m;
}
export const displayTime = t => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
export function observe(s) {
  const actions = [], text = [];
  const add = (target, label) => actions.push({ type: 'tap', target, label });
  if (s.phase === 'ready') { text.push(s.scenario.intention); add('start', 'Begin'); }
  if (s.phase === 'playing') {
    const blocked = blockingNotification(s);
    if (blocked) {
      text.push(`${blocked.title}: ${blocked.body}`, notificationPolicy(s,blocked).requireOpen ? 'Open this notification to continue.' : 'Choose how to handle this notification.');
      actions.push(...notificationActions(s,blocked));
      add('recall', 'Read the m3t4.ai thought above the phone');
      if (taskThoughtVisible(s)) text.push(`m3t4.ai task: ${s.scenario.intention}`);
      return { roundId:s.roundId, revision:s.revision, phase:s.phase, screen:copy(s.screen), text, actions };
    }
    if (lockedDistraction(s)) {
      const view = distractionObservation(s.distractions[s.screen.distractionId], s.elapsed);
      text.push(...view.text); actions.push(...view.actions);
      add('recall', 'Read the m3t4.ai thought above the phone');
      if (taskThoughtVisible(s)) text.push(`m3t4.ai task: ${s.scenario.intention}`);
      return { roundId:s.roundId, revision:s.revision, phase:s.phase, screen:copy(s.screen), text, actions };
    }
    add('home', 'Home'); add('back', 'Back'); add('switcher', 'App switcher'); add('notifications', 'Notifications'); add('recall', 'Remember intention');
    if (taskThoughtVisible(s) || s.screen.app === 'intention') text.push(s.scenario.intention);
    if (s.screen.app === 'home') { const event = s.events.find(e => e.date >= s.today); text.push(s.scenario.date, event ? `Up next: ${event.title}, ${displayTime(event.start)}` : 'No upcoming events'); }
    if (s.screen.app === 'home' || s.screen.app === 'switcher') for (const a of APPS) add(`app:${a.id}`, a.label);
    if (s.screen.app === 'messages') {
      if (!s.screen.contact) { for (const c of shownThreads(s)) { text.push(`${contactName(s,c)}: ${s.messages[c].at(-1)?.text || 'No messages yet'}`); add(`contact:${c}`, contactName(s,c)); } }
      else {
        text.push(...s.messages[s.screen.contact].map(m => `${m.from}: ${m.text}`), `Draft: ${s.drafts[s.screen.contact]}`);
        actions.push({ type: 'type', target: 'reply', label: 'Message text', maxLength: 500 });
        if (s.drafts[s.screen.contact].trim()) add('send', 'Send message');
      }
    }
    observeMini(s, text, actions, displayTime);
    if (s.screen.app === 'distraction') { const view = distractionObservation(s.distractions[s.screen.distractionId], s.elapsed); text.push(...view.text); actions.push(...view.actions); }
    if (s.screen.app === 'feed') {
      const post = doomPost(s.roundId, s.feedIndex);
      text.push(`Doom Scroll · post ${s.feedIndex + 1}`, `@${post.handle}: ${post.text}`, `Language guess: ${post.language}; nonsense: ${post.nonsense}/100; ${post.label}`, s.feedLikes.includes(s.feedIndex) ? 'Liked' : 'Not liked');
      add('next-post', 'Scroll to next post'); if (s.feedIndex > 0) add('previous-post', 'Scroll to previous post'); add('like-post', 'Like or unlike post');
    }
    for (const n of (s.screen.app === 'notifications' ? s.notifications : s.notifications.slice(-1).filter(n => s.elapsed - n.at < 5200 && (configuredNotifications(s) || !mandatoryNotifications(s) || s.elapsed >= s.notificationQuietUntil)))) { text.push(`${n.title}: ${n.body}`); actions.push(...notificationActions(s,n)); }
  }
  return { roundId: s.roundId, revision: s.revision, phase: s.phase, screen: copy(s.screen), text, actions };
}
export function applyAction(state, action) {
  if (!action || action.roundId !== state.roundId || typeof action.id !== 'string' || action.id.length > 160) return { state, accepted: false, reason: 'Wrong round or missing action identity' };
  if (state.seen.includes(action.id)) return { state, accepted: false, reason: 'Duplicate action' };
  if (['finished','expired','lost'].includes(state.phase)) return { state, accepted: false, reason: 'Round is over' };
  if (state.version==='muzil-phone/3' && action.type==='type' && state.editEvents>=RULES.maxEdits) return {state,accepted:false,reason:'Round edit limit reached'};
  if ((state.version==='muzil-phone/3' ? action.type!=='type' && state.semanticActions>=RULES.maxActions : state.seen.length>=RULES.maxActions)) return { state, accepted: false, reason: 'Round action limit reached' };
  const before = observe(state), allowed = before.actions.find(a => a.type === action.type && a.target === action.target);
  if (!allowed) return { state, accepted: false, reason: 'Control is no longer available' };
  if (action.type === 'type' && (typeof action.value !== 'string' || action.value.length > (allowed.maxLength || 5))) return { state, accepted: false, reason: 'Invalid field value' };
  const invalid = validateMini(state, action);
  if (invalid) return { state, accepted:false, reason:invalid };
  // Bind contextual controls to the observed screen; unrelated notifications may arrive meanwhile.
  if (action.screen && JSON.stringify(action.screen) !== JSON.stringify(state.screen) && !['home','recall'].includes(action.target)) return { state, accepted: false, reason: 'Screen changed' };
  const s = copy(state); s.seen.push(action.id); s.revision++; if(action.type==='type')s.editEvents++;else s.semanticActions++;
  const target = action.target;
  if (target === 'start') s.phase = 'playing';
  else if (target === 'home') { s.screen = { app: 'home' }; s.stack = []; }
  else if (target === 'back') s.screen = s.stack.pop() || { app: 'home' };
  else if (target === 'switcher' || target === 'notifications') visit(s, { app: target });
  else if (target === 'recall') { s.recalled++; if (s.scenario.version >= 1) s.taskRecallUntil = s.elapsed + RULES.revealMs; else visit(s, { app: 'intention' }); }
  else if (target.startsWith('app:')) visit(s, { app: target.slice(4) });
  else if (target.startsWith('contact:')) visit(s, { app: 'messages', contact: target.slice(8) });
  else if (target.startsWith('notification:') || target.startsWith('notice:') && ['open','read','answer','decline'].includes(target.split(':')[2])) {
    const n = s.notifications.find(n => n.id === (target.startsWith('notice:') ? target.split(':')[1] : target.slice(13)));
    const policy=notificationPolicy(s,n);
    const configured=configuredNotifications(s);
    const opened=configured ? {...n,...policy} : n;
    if (directed(s) && n.interaction) {
      s.distractions[n.id] = {...decisionDistraction(opened,`${s.scenario.seed}:${n.id}`,s.elapsed),returnScreen:copy(s.screen)};
      if(configured) {
        s.distractions[n.id].required=policy.requireResolution;
        if(target.endsWith(':answer') || target.endsWith(':decline'))actOnDecision(s.distractions[n.id],target.endsWith(':answer')?'bait:answer':'bait:voicemail',s.elapsed);
      }
      visit(s,{app:'distraction',distractionId:n.id});
    } else if (n.distraction) {
      s.distractions[n.id] ||= newDistraction(n.distraction, `${s.roundId}:${n.id}`, s.elapsed, 0, policy.requireResolution);
      if(configured)s.distractions[n.id].notification=opened;
      visit(s, { app:'distraction', distractionId:n.id });
    } else visit(s, { app: n.app, ...(n.contact ? { contact: n.contact } : {}) });
    if(configured) {
      recordNotice(s,n,'opened');
      if(!n.distraction && !n.interaction)recovery(s,'message',n);
    }
    if (!configured && mandatoryNotifications(s)) { s.resolvedNotifications.push(directed(s)?n.id:notificationKey(n)); if (!n.distraction && !n.interaction) {if(directed(s))recovery(s);else s.notificationQuietUntil = s.elapsed + 8000;} }
    s.notifications = s.notifications.filter(x => x.id !== n.id && (directed(s) || !mandatoryNotifications(s) || notificationKey(x) !== notificationKey(n)));
  } else if (target.startsWith('notice:')) {
    const [,id,choice]=target.split(':');
    const n=s.notifications.find(n=>n.id===id);
    if(choice==='expand') n.expanded=!n.expanded;
    else {
      recordNotice(s,n,choice==='dismiss'?'dismissed':'postponed');
      if(choice!=='dismiss')armFollowup(s,n);
      s.notifications=s.notifications.filter(n=>n.id!==id);
      if(directed(s))recovery(s,'message',n);
    }
  } else if (target.startsWith('dismiss:')) s.notifications = s.notifications.filter(n => n.id !== target.slice(8));
  else if (target.startsWith('bait:') && s.distractions[s.screen.distractionId]?.decision) {
    const game=s.distractions[s.screen.distractionId]; s.distractionTaps++;
    actOnDecision(game,target,s.elapsed);
    if(target==='bait:stop' && !game.done) s.metrics.mistakes++;
    if(game.completed) {
      if(['vague','postpone','retain'].includes(game.resolution)) s.metrics.mistakes++;
      if(['vague','postpone'].includes(game.resolution)) {
        armFollowup(s,game.notification);
      }
      if(game.interaction==='group') {
        const contact=game.notification.contact;
        const text={clear:'I cannot join. I am arranging my pickup.',vague:'Sure, maybe!',postpone:'Ask me again in a moment'}[game.resolution];
        s.messages[contact].push({from:'you',contact,text,actionId:action.id});
        if(game.resolution==='clear')s.messages[contact].push({from:contact,text:'Thanks for telling us. We will book without you.'});
      }
      recovery(s,game.interaction,game.notification);
      if(configuredNotifications(s))recordNotice(s,game.notification,game.resolution==='finish' && game.interaction==='call'?(game.route==='answer'?'learned-update':'read-voicemail'):game.resolution);
      if(['retain','leave'].includes(game.resolution)) s.screen=copy(game.returnScreen);
      else if(game.resolution==='source') s.screen={app:'feed'};
      else if(game.resolution==='inspect') s.screen=game.notification.app==='messages'?{app:'messages',contact:game.notification.contact}:{app:'calendar',eventId:'event-0'};
      else if(game.interaction==='call') s.screen=game.route==='answer'?copy(game.returnScreen):{app:'home'};
      else s.screen={app:'home'};
      s.stack=s.stack.filter(screen=>screen.app!=='distraction');
    }
  }
  else if (target === 'bait:source') {
    s.distractionTaps++; s.distractions[s.screen.distractionId].sourceOpened = true; s.notificationQuietUntil = s.elapsed + 8000;
    visit(s, { app:'feed' }); s.stack = s.stack.filter(screen => screen.app !== 'distraction');
  }
  else if (target === 'bait:leave') s.screen = s.stack.pop() || { app:'home' };
  else if (target.startsWith('bait:')) { s.distractionTaps++; s.distractions[s.screen.distractionId] = actOnDistraction(s.distractions[s.screen.distractionId], target, s.elapsed); }
  else if (target === 'reply') s.drafts[s.screen.contact] = action.value;
  else if (actMini(s, action, visit)) { /* Shared mini-app transition. */ }
  else if (target === 'next-post') s.feedIndex++;
  else if (target === 'previous-post') s.feedIndex--;
  else if (target === 'like-post') { if (s.feedLikes.includes(s.feedIndex)) s.feedLikes = s.feedLikes.filter(i => i !== s.feedIndex); else s.feedLikes.push(s.feedIndex); }
  else if (target === 'send') {
    const message = { from: 'you', contact: s.screen.contact, text: configuredNotifications(s) ? s.drafts[s.screen.contact] : s.drafts[s.screen.contact].trim(), actionId: action.id };
    s.messages[s.screen.contact].push(message); s.sent.push(message); s.drafts[s.screen.contact] = '';
  }
  if(configuredNotifications(s) && state.screen.app==='distraction' && s.screen.app!=='distraction') {
    const game=state.distractions[state.screen.distractionId];
    if(game.notification && !s.distractions[state.screen.distractionId]?.completed) {recordNotice(s,game.notification,'left');if(directed(s))recovery(s,game.interaction || 'message',game.notification);}
    s.stack=s.stack.filter(screen=>screen.app!=='distraction');
  }
  cleanMiniNavigation(s);
  if (directed(s)) {
    if(state.screen.app==='calendar' && s.screen.app!=='calendar')signal(s,'calendar-left');
    if(target==='reply')signal(s,'draft-started');
    if(target==='save-alarm' || target==='note')signal(s,'plan-saved');
    if(s.screen.app==='messages' && s.screen.contact==='reception')signal(s,'fact-read');
    if(target==='app:calendar' || target.startsWith('event:')) {
      if(s.external.facts.finish && s.events.some(e=>e.end!==s.external.facts.finish))s.metrics.oldCalendarChecks++;
    }
    if(target==='send') {
      const goal=s.external.goal;
      const messageGoals=g=>g.kind==='message'?[g]:(g.all||g.any||[]).flatMap(messageGoals);
      const goals=messageGoals(goal).filter(g=>g.contact===s.screen.contact);
      const correct=goals.length && goals.every(g=>evaluateGoal(g,s));
      if(!correct)s.metrics.mistakes++;
      s.messages[s.screen.contact].push({from:s.screen.contact,text:correct?'That is the plan I needed. Thank you.':goals.length?'Please check the latest time and entrance.':'Please confirm with the person collecting you.'});
    }
  }
  if (outcome(s)) s.phase = 'finished';
  else if(directed(s)) deliverNext(s,s.elapsed);
  s.log.push({ at: s.elapsed, action: copy(action) });
  s.demonstrations.push({ observation: before, action: { type: action.type, target, ...(action.value !== undefined ? { value: action.value } : {}) }, after: observe(s) });
  return { state: s, accepted: true };
}
export function advance(state, elapsed) {
  if (state.phase !== 'playing' || !Number.isFinite(elapsed) || elapsed < state.elapsed) return state;
  const s = copy(state); s.elapsed = Math.min(Math.floor(elapsed), roundDuration(s.scenario));
  if(directed(s)) {
    if(configuredNotifications(s)) {
      deliverNext(s,state.elapsed);
      // Split at arrivals/quiet-window boundaries so sparse replay clocks and
      // animation ticks attribute the same time without double-counting.
      const boundaries=[...new Set([state.elapsed,s.elapsed,s.notificationQuietUntil,...s.notifications.map(n=>n.at)].filter(t=>t>=state.elapsed&&t<=s.elapsed))].sort((a,b)=>a-b);
      for(let i=0;i<boundaries.length-1;i++) {
        const current={...s,elapsed:boundaries[i]};
        const active=blockingNotification(current) || (s.screen.app==='distraction'?s.distractions[s.screen.distractionId]?.notification:null);
        if(active)accountNotificationTime(s,active,boundaries[i+1]-boundaries[i]);
      }
    } else {
      if(blockingNotification(state) || lockedDistraction(state))s.metrics.interruptionMs+=s.elapsed-state.elapsed;
      deliverNext(s,state.elapsed);
    }
  }
  else for (const n of s.scenario.interruptions) if (n.at <= s.elapsed && !s.delivered.includes(n.id)) {
    s.delivered.push(n.id);
    const repeated = mandatoryNotifications(s) && (s.resolvedNotifications.includes(notificationKey(n)) || s.notifications.some(pending => notificationKey(pending) === notificationKey(n)));
    if (!repeated) s.notifications.push(copy(n));
  }
  if (s.elapsed >= roundDuration(s.scenario)) s.phase = 'expired';
  return s;
}
export function replay(record, until = Infinity) {
  if (![RULES.version, 'muzil-phone/2', 'muzil-phone/1'].includes(record.version)) throw new Error('Unsupported replay version');
  let s = createPhone({ roundId: record.roundId, scenario: record.scenario, controller: record.controller, version:record.version });
  let previousAt=0;
  for (const entry of record.log) {
    if(!Number.isFinite(entry.at)||entry.at<previousAt||entry.at>record.elapsed)throw new Error('Invalid replay clock');
    previousAt=entry.at;
    if (entry.at > until) break;
    s = advance(s, entry.at); const result = applyAction(s, entry.action);
    if (!result.accepted) throw new Error(`Invalid replay: ${result.reason}`);
    s = result.state;
  }
  s=advance(s, Math.min(until, record.elapsed));
  if(record.version==='muzil-phone/3' && record.ending==='lost' && until>=record.elapsed && s.phase==='playing')s.phase='lost';
  return s;
}
export function makeReplay(s) { return copy({ ...(s.director?{directorEvents:s.director.events}:{}), ...(s.phase==='lost'?{ending:'lost'}:{}), version: s.version, roundId: s.roundId, scenario: s.scenario, controller: s.controller, elapsed: s.elapsed, log: s.log }); }
