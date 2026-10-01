export const RULES = Object.freeze({ version: 'muzil-phone/2', durationMs: 180000, maxActions: 400, revealMs: 5000 });
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
export const APPS = [
  { id: 'messages', label: 'Messages', icon: 'message', color: 'green' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar', color: 'coral' },
  { id: 'clock', label: 'Clock', icon: 'clock', color: 'ink' },
  { id: 'notes', label: 'Notes', icon: 'notes', color: 'yellow' },
  { id: 'feed', label: 'Doom Scroll', icon: 'loop', color: 'violet' },
  { id: 'contacts', label: 'Contacts', icon: 'person', color: 'blue' },
];
