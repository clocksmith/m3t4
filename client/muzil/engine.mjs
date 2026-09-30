import { RULES, SCENARIOS, APPS } from './scenarios.mjs';
const copy = x => structuredClone(x);
export function createPhone({ roundId, scenario = SCENARIOS[0], controller = 'human' }) {
  if (!roundId) throw new Error('A round identity is required');
  return { version: RULES.version, roundId, scenario: copy(scenario), controller, phase: 'ready', elapsed: 0,
    screen: { app: 'home' }, stack: [], revision: 0, notifications: [], delivered: [], seen: [],
    messages: { mom: [{ from: 'mom', text: scenario.incoming }], group: [{ from: 'group', text: 'Would you rather fight one horse-sized duck or finish your errands?' }] },
    drafts: { mom: '', group: '' }, notes: scenario.initialNotes || '', alarms: [], alarmDraft: '07:00', feedIndex: 0, sent: [], log: [], demonstrations: [], recalled: 0 };
}
function visit(s, screen) { s.stack.push(copy(s.screen)); s.screen = screen; }
export function outcome(s) {
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
    add('home', 'Home'); add('back', 'Back'); add('switcher', 'App switcher'); add('notifications', 'Notifications'); add('recall', 'Remember intention');
    if (s.elapsed <= RULES.revealMs || s.screen.app === 'intention') text.push(s.scenario.intention);
    if (s.screen.app === 'home') text.push(s.scenario.date, `Up next: ${s.scenario.event}, ${displayTime(s.scenario.start)}`);
    if (s.screen.app === 'home' || s.screen.app === 'switcher') for (const a of APPS) add(`app:${a.id}`, a.label);
    if (s.screen.app === 'messages') {
      if (!s.screen.contact) { text.push(...['mom','group'].map(c => `${c}: ${s.messages[c].at(-1).text}`)); add('contact:mom', 'Mom'); add('contact:group', 'The group chat'); }
      else {
        text.push(...s.messages[s.screen.contact].map(m => `${m.from}: ${m.text}`), `Draft: ${s.drafts[s.screen.contact]}`);
        actions.push({ type: 'type', target: 'reply', label: 'Message text', maxLength: 500 });
        if (s.drafts[s.screen.contact].trim()) add('send', 'Send message');
      }
    }
    if (s.screen.app === 'calendar') text.push(s.scenario.date, `${s.scenario.event}: ${displayTime(s.scenario.start)}–${displayTime(s.scenario.end)}`, s.scenario.note);
    if (s.screen.app === 'contacts') { add('contact:mom', 'Message Mom'); add('contact:group', 'Open group chat'); }
    if (s.screen.app === 'clock') { text.push(...s.alarms.map(a => `Alarm: ${a}`), `New alarm: ${s.alarmDraft}`); actions.push({ type: 'type', target: 'alarm', label: 'Alarm time HH:MM' }); add('save-alarm', 'Add alarm'); }
    if (s.screen.app === 'notes') { text.push(s.notes); actions.push({ type: 'type', target: 'note', label: 'Notes', maxLength: 1000 }); }
    if (s.screen.app === 'feed') { text.push(['Someone restoring a skillet. They have just located a sponge.', 'Part 2: the sponge has a backstory.', 'You have become invested in cookware.'][s.feedIndex % 3]); add('next-post', 'Next post'); }
    for (const n of (s.screen.app === 'notifications' ? s.notifications : s.notifications.slice(-1).filter(n => s.elapsed - n.at < 5200))) { text.push(`${n.title}: ${n.body}`); add(`notification:${n.id}`, `Open ${n.title}`); add(`dismiss:${n.id}`, `Dismiss ${n.title}`); }
  }
  return { roundId: s.roundId, revision: s.revision, phase: s.phase, screen: copy(s.screen), text, actions };
}
export function applyAction(state, action) {
  if (!action || action.roundId !== state.roundId || typeof action.id !== 'string' || action.id.length > 160) return { state, accepted: false, reason: 'Wrong round or missing action identity' };
  if (state.seen.includes(action.id)) return { state, accepted: false, reason: 'Duplicate action' };
  if (state.phase === 'finished' || state.phase === 'expired') return { state, accepted: false, reason: 'Round is over' };
  if (state.seen.length >= RULES.maxActions) return { state, accepted: false, reason: 'Round action limit reached' };
  const before = observe(state), allowed = before.actions.find(a => a.type === action.type && a.target === action.target);
  if (!allowed) return { state, accepted: false, reason: 'Control is no longer available' };
  if (action.type === 'type' && (typeof action.value !== 'string' || action.value.length > (allowed.maxLength || 5))) return { state, accepted: false, reason: 'Invalid field value' };
  if (action.target === 'alarm' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(action.value)) return { state, accepted: false, reason: 'Use a valid time' };
  // Bind contextual controls to the observed screen; unrelated notifications may arrive meanwhile.
  if (action.screen && JSON.stringify(action.screen) !== JSON.stringify(state.screen) && !['home','recall'].includes(action.target)) return { state, accepted: false, reason: 'Screen changed' };
  const s = copy(state); s.seen.push(action.id); s.revision++;
  const target = action.target;
  if (target === 'start') s.phase = 'playing';
  else if (target === 'home') { s.screen = { app: 'home' }; s.stack = []; }
  else if (target === 'back') s.screen = s.stack.pop() || { app: 'home' };
  else if (target === 'switcher' || target === 'notifications') visit(s, { app: target });
  else if (target === 'recall') { s.recalled++; visit(s, { app: 'intention' }); }
  else if (target.startsWith('app:')) visit(s, { app: target.slice(4) });
  else if (target.startsWith('contact:')) visit(s, { app: 'messages', contact: target.slice(8) });
  else if (target.startsWith('notification:')) {
    const n = s.notifications.find(n => n.id === target.slice(13));
    visit(s, { app: n.app, ...(n.contact ? { contact: n.contact } : {}) }); s.notifications = s.notifications.filter(x => x.id !== n.id);
  } else if (target.startsWith('dismiss:')) s.notifications = s.notifications.filter(n => n.id !== target.slice(8));
  else if (target === 'reply') s.drafts[s.screen.contact] = action.value;
  else if (target === 'note') s.notes = action.value;
  else if (target === 'alarm') s.alarmDraft = action.value;
  else if (target === 'save-alarm') { if (!s.alarms.includes(s.alarmDraft)) s.alarms.push(s.alarmDraft); }
  else if (target === 'next-post') s.feedIndex++;
  else if (target === 'send') {
    const message = { from: 'you', contact: s.screen.contact, text: s.drafts[s.screen.contact].trim(), actionId: action.id };
    s.messages[s.screen.contact].push(message); s.sent.push(message); s.drafts[s.screen.contact] = '';
  }
  if (outcome(s)) s.phase = 'finished';
  s.log.push({ at: s.elapsed, action: copy(action) });
  s.demonstrations.push({ observation: before, action: { type: action.type, target, ...(action.value !== undefined ? { value: action.value } : {}) }, after: observe(s) });
  return { state: s, accepted: true };
}
export function advance(state, elapsed) {
  if (state.phase !== 'playing' || !Number.isFinite(elapsed) || elapsed < state.elapsed) return state;
  const s = copy(state); s.elapsed = Math.min(Math.floor(elapsed), RULES.durationMs);
  for (const n of s.scenario.interruptions) if (n.at <= s.elapsed && !s.delivered.includes(n.id)) { s.delivered.push(n.id); s.notifications.push(copy(n)); }
  if (s.elapsed >= RULES.durationMs) s.phase = 'expired';
  return s;
}
export function replay(record, until = Infinity) {
  if (record.version !== RULES.version) throw new Error('Unsupported replay version');
  let s = createPhone({ roundId: record.roundId, scenario: record.scenario, controller: record.controller });
  for (const entry of record.log) {
    if (entry.at > until) break;
    s = advance(s, entry.at); const result = applyAction(s, entry.action);
    if (!result.accepted) throw new Error(`Invalid replay: ${result.reason}`);
    s = result.state;
  }
  return advance(s, Math.min(until, record.elapsed));
}
export function makeReplay(s) { return copy({ version: s.version, roundId: s.roundId, scenario: s.scenario, controller: s.controller, elapsed: s.elapsed, log: s.log }); }
