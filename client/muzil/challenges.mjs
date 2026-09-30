// Declarative phone state and result predicates. No executable code in a challenge.
const APPS = new Set(['messages', 'calendar', 'clock', 'notes', 'feed', 'contacts']);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const plain = x => !!x && typeof x === 'object' && !Array.isArray(x);
const string = (x, max = 1000) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
const identifier = x => typeof x === 'string' && ID.test(x) && !['constructor', 'prototype'].includes(x);
const require = (valid, message) => { if (!valid) throw new Error(`Invalid challenge: ${message}`); };
export function validateChallenge(value) {
  require(plain(value) && value.version === 1, 'expected version 1');
  const c = structuredClone(value);
  require(identifier(c.id) && string(c.title, 100) && string(c.intention, 500), 'id, title and intention are required');
  require(string(c.success, 300) && string(c.date, 100), 'success text and date are required');
  require(Number.isInteger(c.durationMs) && c.durationMs >= 30000 && c.durationMs <= 600000, 'duration must be 30–600 seconds');
  require(plain(c.initial), 'initial phone state is required');
  const { contacts, calendar, notes, alarms } = c.initial;
  require(Array.isArray(contacts) && contacts.length >= 1 && contacts.length <= 12, 'provide 1–12 contacts');
  const ids = new Set();
  for (const contact of contacts) {
    require(plain(contact) && identifier(contact.id) && !ids.has(contact.id) && string(contact.name, 60), 'contact IDs must be unique');
    require(Array.isArray(contact.messages) && contact.messages.length >= 1 && contact.messages.length <= 12 && contact.messages.every(m => string(m, 500)), 'contact messages must be text');
    ids.add(contact.id);
  }
  require(Array.isArray(calendar) && calendar.length <= 12, 'calendar must be an array');
  for (const event of calendar) require(plain(event) && string(event.title, 100) && TIME.test(event.start) && TIME.test(event.end) && event.end > event.start && typeof event.note === 'string' && event.note.length <= 500, 'invalid calendar event');
  require(typeof notes === 'string' && notes.length <= 1000, 'notes must be at most 1000 characters');
  require(Array.isArray(alarms) && alarms.length <= 12 && alarms.every(t => TIME.test(t)), 'invalid initial alarms');
  let count = 0;
  function checkGoal(goal, depth = 0) {
    require(plain(goal) && depth <= 4 && ++count <= 32, 'goal tree is too large');
    const shapes = ['all', 'any', 'kind'].filter(k => Object.hasOwn(goal, k));
    require(shapes.length === 1, 'use one of all, any or kind per goal');
    if (goal.all || goal.any) {
      const children = goal.all || goal.any;
      require(Array.isArray(children) && children.length >= 1 && children.length <= 12, 'goal groups must not be empty');
      children.forEach(child => checkGoal(child, depth + 1)); return;
    }
    require(['message', 'alarm', 'note'].includes(goal.kind), 'unknown result predicate');
    if (goal.kind === 'alarm') { require(TIME.test(goal.time), 'alarm goal needs HH:MM'); return; }
    if (goal.kind === 'message') require(ids.has(goal.contact), 'message goal references a missing contact');
    require(goal.time !== undefined || goal.includes !== undefined || goal.choice !== undefined, 'text goals need conditions');
    if (goal.time !== undefined) require(goal.kind === 'message' && TIME.test(goal.time), 'invalid message time');
    if (goal.includes !== undefined) require(Array.isArray(goal.includes) && goal.includes.length >= 1 && goal.includes.length <= 12 && goal.includes.every(t => string(t, 100)), 'includes must contain text');
    if (goal.choice !== undefined) require(plain(goal.choice) && Array.isArray(goal.choice.options) && goal.choice.options.length >= 2 && goal.choice.options.length <= 12 && goal.choice.options.every(t => string(t, 100)) && goal.choice.options.includes(goal.choice.expected), 'invalid exclusive text choice');
  }
  checkGoal(c.goal);
  require(Array.isArray(c.interruptions) && c.interruptions.length <= 50, 'invalid interruptions');
  const delivered = new Set();
  for (const n of c.interruptions) {
    require(plain(n) && identifier(n.id) && !delivered.has(n.id) && APPS.has(n.app), 'invalid notification identity or app');
    require(Number.isInteger(n.at) && n.at >= 0 && n.at < c.durationMs && string(n.title, 100) && string(n.body, 500), 'invalid notification content or time');
    require(n.contact === undefined || (n.app === 'messages' && ids.has(n.contact)), 'notification references a missing contact');
    require(n.interruptive === undefined || typeof n.interruptive === 'boolean', 'invalid notification interruption');
    require(n.distraction === undefined || ['reveal','pairs','timing'].includes(n.distraction), 'unknown notification distraction');
    delivered.add(n.id);
  }
  c.interruptions.sort((a, b) => a.at - b.at);
  return c;
}
export function parseCatalog(value) {
  require(plain(value) && value.schema === 'muzil-challenges/v1' && Array.isArray(value.challenges) && value.challenges.length >= 1 && value.challenges.length <= 100, 'expected a muzil-challenges/v1 catalog');
  const challenges = value.challenges.map(validateChallenge);
  require(new Set(challenges.map(c => c.id)).size === challenges.length, 'challenge IDs must be unique');
  return challenges;
}
export async function loadChallenges() {
  const response = await fetch(new URL('./challenges.json', import.meta.url));
  if (!response.ok) throw new Error('Challenge catalog could not be loaded');
  return parseCatalog(await response.json());
}
const normalize = text => ` ${text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
export function matchesTime(text, expected) {
  const matches = [...text.matchAll(/\b(\d{1,2})[:.](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/gi)];
  if (matches.length !== 1) return false;
  let [, h, m, suffix = ''] = matches[0]; h = Number(h); m = Number(m);
  const [eh, em] = expected.split(':').map(Number);
  if (h > 23 || m > 59 || (suffix && (h < 1 || h > 12))) return false;
  if (/p/i.test(suffix) && h < 12) h += 12;
  if (/a/i.test(suffix) && h === 12) h = 0;
  if (!suffix && h < 12 && eh >= 12) h += 12;
  return h === eh && m === em;
}
export function evaluateGoal(goal, state) {
  if (goal.all) return goal.all.every(g => evaluateGoal(g, state));
  if (goal.any) return goal.any.some(g => evaluateGoal(g, state));
  if (goal.kind === 'alarm') return state.alarms.includes(goal.time);
  const raw = goal.kind === 'note' ? state.notes : state.sent.filter(m => m.contact === goal.contact).at(-1)?.text;
  if (typeof raw !== 'string') return false;
  const text = normalize(raw);
  if (goal.time && !matchesTime(raw, goal.time)) return false;
  if (goal.includes && !goal.includes.every(value => text.includes(normalize(value)))) return false;
  if (goal.choice) {
    const found = goal.choice.options.filter(value => text.includes(normalize(value)));
    if (found.length !== 1 || found[0] !== goal.choice.expected) return false;
  }
  return true;
}
export const roundDuration = scenario => scenario.durationMs || 180000;
export const calendarEvents = scenario => scenario.initial?.calendar || [{ title: scenario.event, start: scenario.start, end: scenario.end, note: scenario.note }];
export const contactName = (state, id) => state.scenario.initial?.contacts.find(c => c.id === id)?.name || ({ mom: 'Mom', group: 'The group chat' }[id] || id);
