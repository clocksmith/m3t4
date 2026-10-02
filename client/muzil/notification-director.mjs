// Policy is scenario data. No wall clock, opponent state or unrecorded randomness.
export const directed = s => s.scenario.version === 2;
export function signal(s, name) {
  if (directed(s) && s.director.signals[name] === undefined) s.director.signals[name] = s.elapsed;
}
export function deliverNext(s, from) {
  if (!directed(s) || s.notifications.length || s.screen.app === 'distraction' && s.distractions[s.screen.distractionId]?.required) return;
  const candidates = [...s.scenario.interruptions,...s.director.followups].filter(n => !s.delivered.includes(n.id) && (!n.after || s.delivered.includes(n.after))).map(n => {
    const triggerAt = n.trigger ? s.director.signals[n.trigger] : 0;
    const due = !n.trigger || triggerAt === undefined ? n.at : Math.min(n.at, triggerAt + (n.delayMs || 0));
    return { n, at:Math.max(from, due, s.notificationQuietUntil, s.director.nextAt) };
  }).filter(e => e.at <= s.elapsed).sort((a,b) => a.at-b.at || a.n.id.localeCompare(b.n.id));
  const next = candidates[0]; if (!next) return;
  const {n,at} = next;
  // An event identity is delivered once, even when its conversation develops again.
  s.delivered.push(n.id); s.director.events.push({id:n.id,episode:n.episode || n.id,at});
  s.director.nextAt = at + s.scenario.pressure.minimumGapMs;
  if (n.effects) {
    if (n.effects.goal) s.external.goal = structuredClone(n.effects.goal);
    Object.assign(s.external.facts,n.effects.facts || {}); s.external.revision++;
    if (n.effects.calendar) {
      const {index,event} = n.effects.calendar;
      const current = s.events.find(e=>e.id===`event-${index}`);
      if (current) Object.assign(current,structuredClone(event));
      else s.events.push({...structuredClone(event),id:`event-${index}`,date:s.today});
    }
    for (const m of n.effects.messages || []) s.messages[m.contact].push({from:m.contact,text:m.text,eventId:n.id});
  }
  if (n.contact && !(n.effects?.messages || []).some(m=>m.contact===n.contact && m.text===n.body)) s.messages[n.contact].push({from:n.contact,text:n.body,eventId:n.id});
  s.notifications.push({...structuredClone(n),at});
  s.metrics.interruptionMs += s.elapsed-at;
}
export function recovery(s, kind = 'message') {
  s.notificationQuietUntil = s.elapsed + (s.scenario.pressure.recoveryMs[kind] ?? s.scenario.pressure.recoveryMs.message);
  signal(s,'detour-return');
}
