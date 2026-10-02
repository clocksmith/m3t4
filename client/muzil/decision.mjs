import { observe, applyAction } from './engine.mjs';
import { parseDecision } from './controller.mjs';

// One owner for pending decisions. A takeover or rematch retires the owner even
// when a provider ignores cancellation and eventually returns a valid-looking move.
export function createDecisionOwner({ id = () => crypto.randomUUID(), now = () => performance.now() } = {}) {
  let active = null;
  const receipts = [];
  function cancel() { active?.abort.abort(); active = null; }
  return {
    receipts,
    cancel,
    begin(state, { matchId, controllerId }) {
      cancel();
      if (!matchId || !controllerId || state.phase !== 'playing') throw new Error('Active match and controller required');
      const observation = observe(state);
      const binding = Object.freeze({ matchId, roundId: state.roundId, controllerId,
        attemptId: id(), observationId: id(), revision: state.revision });
      active = { binding, observation, abort: new AbortController(), started: now() };
      return { binding, observation, signal: active.abort.signal };
    },
    accept(state, result, { matchId, controllerId }) {
      const pending = active;
      const reject = (reason, stale = false) => {
        receipts.push({ ...result.binding, accepted: false, reason, timeToValidActionMs: null,
          execution: result.execution || null });
        return { state, accepted: false, reason, stale };
      };
      if (!pending || pending.abort.signal.aborted) return reject('Decision owner retired');
      const binding = pending.binding;
      if (Object.keys(binding).some(key => result.binding?.[key] !== binding[key])) return reject('Inference response identity mismatch');
      active = null;
      if (matchId !== binding.matchId || controllerId !== binding.controllerId || state.roundId !== binding.roundId
        || state.revision !== binding.revision || state.phase !== 'playing') return reject('Phone changed during inference');
      // Elapsed time and notification arrival do not change the action revision.
      // The engine still rechecks current controls, including expired banners.
      let action;
      try { action = parseDecision(result.text, pending.observation); }
      catch (error) { return reject(error.message); }
      const applied = applyAction(state, { ...action, id: binding.attemptId, roundId: binding.roundId,
        screen: pending.observation.screen, decision: binding });
      if(!applied.accepted && ['Control is no longer available','Screen changed'].includes(applied.reason)) {
        const current=observe(state);
        const changed=JSON.stringify(current.actions)!==JSON.stringify(pending.observation.actions);
        if(changed)return reject(applied.reason,true);
      }
      receipts.push({ ...binding, accepted: applied.accepted, reason: applied.reason || null,
        timeToValidActionMs: applied.accepted ? now() - pending.started : null,
        execution: result.execution || null });
      return applied;
    },
  };
}
