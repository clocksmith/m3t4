export const RULES = Object.freeze({ version: 'muzil-phone/1', durationMs: 180000, maxActions: 400, revealMs: 5000 });
export const SCENARIOS = Object.freeze([
  { id: 'pickup', title: 'A small favor', intention: 'Tell Mom what time to pick you up after your appointment.', contact: 'mom', name: 'Mom', event: 'Dentist', start: '16:50', end: '17:40', date: 'Monday, September 28', incoming: 'What time should I pick you up? Outside the dentist, right?', note: 'Appointment moved. Use the updated finish time.',
    interruptions: [
      { id: 'calendar-update', at: 6500, app: 'calendar', title: 'Your appointment changed', body: 'Dentist now finishes at 5:40 PM. Same place.' },
      { id: 'group', at: 12000, app: 'messages', contact: 'group', title: 'The group chat · 12 messages', body: 'Wait. Is that your old apartment in this video?' },
      { id: 'feed', at: 20500, app: 'feed', title: 'Just one thing', body: 'This pan was abandoned for 40 years. Part 1 of 38.' },
      { id: 'mom-followup', at: 33000, app: 'messages', contact: 'mom', title: 'Mom', body: 'No rush. Just let me know the time.' },
    ] },
  { id: 'pickup-variation', title: 'Same favor. Different day.', intention: 'Tell Mom what time to pick you up after your appointment.', contact: 'mom', name: 'Mom', event: 'Eye appointment', start: '14:20', end: '15:15', date: 'Tuesday, September 29', incoming: 'When will you be done at the eye doctor? I can pick you up.', note: 'The appointment was moved to the afternoon.',
    interruptions: [
      { id: 'calendar-update', at: 6500, app: 'calendar', title: 'Calendar updated', body: 'Eye appointment ends at 3:15 PM.' },
      { id: 'group', at: 12000, app: 'messages', contact: 'group', title: 'The group chat', body: 'We need your opinion on something completely unimportant.' },
      { id: 'feed', at: 20500, app: 'feed', title: 'For you, apparently', body: 'A tiny apartment with a surprisingly long tour.' },
    ] },
]);
// Keep the original scenarios stable for saved replays and model qualification.
// New rounds require a useful final state across three apps, in either order.
export const PLAY_SCENARIOS = Object.freeze(SCENARIOS.map((base, index) => ({
  ...base,
  id: `${base.id}-errands`,
  title: 'Before you put it down',
  intention: 'Tell Mom the updated pickup time and entrance. Set an alarm for 10 minutes before pickup.',
  location: index ? 'garden gate' : 'side entrance',
  entrances: index ? ['front gate', 'garden gate'] : ['main entrance', 'side entrance'],
  requiredAlarm: index ? '15:05' : '17:30',
  initialNotes: index
    ? 'Eye doctor · pickup\n\nThe front gate is locked this afternoon. Meet at the garden gate.\n\nShopping: coffee, lemons, batteries.'
    : 'Dentist · pickup\n\nThe main entrance is closed for repairs. Meet at the side entrance.\n\nShopping: coffee, lemons, batteries.',
  incoming: index
    ? 'Still 2:45 at the front gate? Check the updated appointment and your pickup note. Let me know both.'
    : 'Still 5:20 at the main entrance? Check the updated appointment and your pickup note. Let me know both.',
  note: 'This is the updated appointment. Pickup entrance is saved in Notes.',
  interruptions: [
    { id: 'group-urgent', at: 7000, app: 'messages', contact: 'group', title: 'The group chat · 14 messages', body: 'Quick. We need your vote before we book it.' },
    { id: 'calendar-update', at: 15000, app: 'calendar', title: 'Appointment updated', body: 'The old pickup time is out of date. Check Calendar.' },
    { id: 'feed', at: 23000, app: 'feed', title: 'Someone you know is in this', body: 'Wait until you see the last five seconds.' },
    { id: 'pickup-note', at: 31000, app: 'notes', title: 'Pickup note', body: 'The usual entrance is closed. You saved the alternative.' },
    { id: 'group-again', at: 41000, app: 'messages', contact: 'group', title: 'The group chat', body: 'We went with your suggestion. You did suggest that, right?' },
    { id: 'feed-two', at: 52000, app: 'feed', title: 'Part 2 just dropped', body: 'The sponge has a backstory.' },
    { id: 'mom-followup', at: 65000, app: 'messages', contact: 'mom', title: 'Mom', body: 'Send me the time and entrance together so I can find you.' },
    { id: 'group-photo', at: 80000, app: 'messages', contact: 'group', title: 'The group chat · photo', body: 'Is this your old apartment?' },
    { id: 'feed-three', at: 97000, app: 'feed', title: 'Your daily rabbit hole', body: 'A tiny apartment. A surprisingly long tour.' },
    { id: 'mom-reminder', at: 115000, app: 'messages', contact: 'mom', title: 'Mom', body: 'Remember your alarm. You always lose track of time in there.' },
    { id: 'group-last', at: 135000, app: 'messages', contact: 'group', title: 'The group chat', body: 'Okay, last question. Probably.' },
    { id: 'feed-last', at: 155000, app: 'feed', title: 'You’re almost at the good part', body: 'Just one more.' },
  ],
})));
export const APPS = [
  { id: 'messages', label: 'Messages', icon: 'message', color: 'green' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', color: 'coral' },
  { id: 'clock', label: 'Clock', icon: 'clock', color: 'ink' },
  { id: 'notes', label: 'Notes', icon: 'notes', color: 'yellow' },
  { id: 'feed', label: 'Loop', icon: 'loop', color: 'violet' },
  { id: 'contacts', label: 'Contacts', icon: 'person', color: 'blue' },
];
