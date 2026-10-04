import { evaluateGoal } from './challenges.mjs';
export function obligations(goal, state) {
  const canonical = value => value && typeof value==='object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
  const satisfied = g => {
    if(g.all)return new Set(g.all.flatMap(child=>[...satisfied(child)]));
    if(g.any)return g.any.map(satisfied).sort((a,b)=>b.size-a.size)[0];
    return new Set(evaluateGoal(g,state)?[JSON.stringify(canonical(g))]:[]);
  };
  return satisfied(goal).size;
}
export function roundResult(s) {
  return {finished:s.phase==='finished',elapsed:s.elapsed,obligations:obligations(s.external?.goal || s.scenario.goal || {kind:'alarm',time:'00:00'},s),mistakes:s.metrics?.mistakes || 0};
}
export function roundReport(s) {
  if (!s.metrics) return `${Math.round(s.elapsed/1000)} seconds · ${s.log.length} actions · ${s.recalled} reminders.`;
  const {interruptionMs,oldCalendarChecks,mistakes} = s.metrics;
  const handling=s.scenario.notificationPolicies ? `${Math.round((s.metrics.taskUpdateMs||0)/1000)} seconds handling task updates and ${Math.round((s.metrics.detourMs||0)/1000)} seconds on unrelated detours${s.metrics.mixedMs ? `, plus ${Math.round(s.metrics.mixedMs/1000)} seconds on mixed interruptions` : ''}` : `${Math.round(interruptionMs/1000)} seconds resolving interruptions`;
  return `You spent ${handling}${oldCalendarChecks ? `, checked the old appointment ${oldCalendarChecks === 1 ? 'once' : `${oldCalendarChecks} times`}` : ''}, and ${s.phase==='finished' ? 'finished using the current details' : s.phase==='lost'?'were still working when your friend finished':'ran out of time before finishing'}${mistakes ? ` after ${mistakes} ${mistakes===1?'mistake':'mistakes'}` : ''}.`;
}
