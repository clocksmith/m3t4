import { miniScreen, searchField } from './mini-app-view.mjs';
import { shownThreads } from './mini-apps.mjs';
import { distractionScreen, updateDistractionMotion, notificationBait } from './distraction-view.mjs';
import { bindToasterEntry } from './toaster-entry.mjs';
import { APPS, RULES } from './scenarios.mjs';
import { loadChallenges, validateChallenge, parseCatalog, contactName, roundDuration } from './challenges.mjs';
import { DoomFeed } from './doom-feed.mjs';
const SCENARIOS = await loadChallenges();
import { createPhone, applyAction, advance, observe, displayTime, makeReplay, replay, blockingNotification } from './engine.mjs';
import { LocalController } from './controller.mjs';
import { PeerController } from './peer.mjs';
import { createDecisionOwner } from './decision.mjs';
import { MeshController } from './mesh.mjs';
const $ = id => document.getElementById(id);
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const iconPaths = {
  message: '<path d="M4 5h16v11H9l-5 4V5Z"/><path d="M8 9h8M8 12h5"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-12 4h3m2 0h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
  notes: '<path d="M6 3h12v18H6zM9 8h6m-6 4h6m-6 4h4"/>',
  loop: '<path d="M8 5c-7 0-7 14 0 14 5 0 3-14 8-14 7 0 7 14 0 14-5 0-3-14-8-14Z"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || iconPaths.message}</svg>`;
const uuid = () => crypto.randomUUID();
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } };
const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('Browser storage is unavailable. Export your profile to keep it.'); } };
let profile = read('muzil.profile.v1', { schema: 'muzil.profile/v1', id: uuid(), version: 1, objective: 'finish', rounds: 0, examples: [] });
if (!Array.isArray(profile.examples)) profile = { schema: 'muzil.profile/v1', id: uuid(), version: 1, objective: 'finish', rounds: 0, examples: [] };
let lastReplay = read('muzil.replay.v1', null), state = createPhone({ roundId: uuid(), scenario: SCENARIOS[0] });
let roundStarted = 0, toastTimer, interval, replayStarted = 0, replayMode = false, agentRunning = false, requestController = null, revealDismissed = false, recorded = false, mode = 'play';
let memory = [], inferenceMs = 0, race = null, invitation = null, doomView = null;
let nextChallenge = Number(profile.rounds || 0) % SCENARIOS.length;
const selectedChallenge = () => SCENARIOS.find(s => s.id === $('challenge-select').value) || SCENARIOS[nextChallenge % SCENARIOS.length];
function renderChallengeMenu() { $('challenge-select').innerHTML = '<option value="">Next challenge</option>' + SCENARIOS.map(s => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join(''); }
renderChallengeMenu();
const local = new LocalController();
export const mesh = new MeshController({ onChange: updateConnection });
const decisions = createDecisionOwner();
let agentOwnerId = null;
const peer = new PeerController({ local, onChange: updateConnection, onGame: handleGame });
function toast(message) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
function report(error) { toast(error.message || String(error)); }
function updateConnection() {
  if (race && ['closed','failed','offline'].includes(peer.state)) { $('race-status').textContent = 'Peer disconnected. This race is interrupted; you can keep playing.'; race = null; }
  const ready = mesh.ready || peer.ready || !!local.session;
  if ($('partition-state')) $('partition-state').textContent = mesh.status;
  $('connection-label').textContent = mesh.ready ? 'Distributed helper ready' : peer.ready ? 'Peer ready' : local.session ? 'Helper ready here' : 'Connect a helper';
  document.querySelectorAll('.status-dot').forEach(n => n.classList.toggle('ready', ready));
  $('mesh-state').textContent = peer.ready ? `Prepared peer · ${peer.remote.model}` : `Peer ${peer.state}${peer.state === 'connected' ? ' · waiting for a prepared model' : ''}`;
}
function setMode(next) { mode = next; doomView?.setActive(next === 'play' && state.phase === 'playing'); $('site-menu').open = false; for (const name of ['play','train','finish']) $(`${name}-view`).hidden = name !== next; document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('active', b.dataset.mode === next)); if (next === 'train') renderProfile(); }
function stopAgent() { decisions.cancel(); agentOwnerId = null; agentRunning = false; requestController?.abort(); requestController = null; $('agent-round').textContent = 'Watch AI play'; }
function newRound(controller = 'human', options = {}) {
  const from = options.entryRect || (!$('intro').hidden && mode === 'play' ? $('peek-phone').getBoundingClientRect() : null);
  stopAgent(); replayMode = false; recorded = false; revealDismissed = false; inferenceMs = 0;
  if (!options.raceId) { if (race && peer.state === 'connected') peer.sendGame({ type: 'leave', raceId: race.id }); race = null; $('race-status').textContent = ''; }
  const scenario = options.scenario || selectedChallenge(); nextChallenge = (SCENARIOS.indexOf(scenario) + 1) % SCENARIOS.length;
  state = createPhone({ roundId: options.raceId || uuid(), scenario, controller }); memory = [observe(state)]; roundStarted = performance.now();
  dispatch({ type: 'tap', target: 'start' }, false); setMode('play');
  $('round-status').textContent = controller === 'agent' ? 'Your stand-in is reading the phone.' : '';
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (from && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const to = $('phone').getBoundingClientRect();
    $('phone').animate([
      { transformOrigin: 'top left', transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: .5 },
      { transformOrigin: 'top left', transform: 'none', opacity: 1 },
    ], { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  $('phone').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function remember(observation) { memory.push(observation); if (memory.length > 12) memory.splice(1, 1); }
function dispatch(action, human = true, renderAfter = true) {
  if (replayMode) return;
  if (state.phase === 'playing') { state = advance(state,performance.now() - roundStarted); if (state.phase === 'expired') { complete(); render(); return; } }
  if (human && state.controller !== 'human') { stopAgent(); state.controller = 'mixed'; }
  const result = applyAction(state, { ...action, roundId: state.roundId, id: uuid(), screen: structuredClone(state.screen) });
  if (!result.accepted) { if (state.phase !== 'ready') toast(result.reason); return; }
  state = result.state; remember(observe(state));
  if (state.phase === 'finished') complete();
  if (renderAfter || state.phase === 'finished') render();
}
function complete() {
  stopAgent();
  if (recorded || replayMode) return;
  recorded = true; lastReplay = makeReplay(state);
  if (race?.id === state.roundId) { race.local = { finished: state.phase === 'finished', elapsed: state.elapsed }; try { peer.sendGame({ type:'result', raceId:race.id, record:lastReplay }); } catch (e) { report(e); } raceSummary(); } lastReplay.profile = { id:profile.id, version:profile.version, objective:profile.objective }; lastReplay.inferenceMs = Math.round(inferenceMs); save('muzil.replay.v1', lastReplay);
  if (state.controller === 'human') {
    const examples = state.demonstrations.filter((e,i,all) => e.action.target !== 'start' && !(e.action.type === 'type' && all[i+1]?.action.type === 'type' && all[i+1]?.action.target === e.action.target)).map(e => ({ observation: e.observation, action: e.action, after: e.after }));
    profile.examples = [...profile.examples, ...examples].slice(-36); profile.rounds = (profile.rounds || 0) + 1; profile.version++; save('muzil.profile.v1', profile);
  }
  $('round-status').textContent = state.phase === 'finished' ? 'Intention kept. Your replay is saved.' : 'The phone won this one. Your replay is saved.';
}
const launch = a => `<button class="app-launch" data-action="app:${a.id}" aria-label="Open ${a.label}"><span class="app-tile ${a.color}">${a.id === 'calendar' ? `<span class="calendar-tile"><small>${state.scenario.date.startsWith('Monday') ? 'MON' : 'TUE'}</small>${state.scenario.date.startsWith('Monday') ? '28' : '29'}</span>` : icon(a.icon)}</span><span>${a.label}</span>${a.id === 'messages' ? '<i class="badge">2</i>' : ''}</button>`;
function home() {
  const event = state.events.find(e => e.date >= state.today);
  return `<div class="home-screen"><div class="home-date">${esc(state.scenario.date)}</div><div class="home-time">9:41</div><div class="weather">☀ <span>19° · A perfectly ordinary day</span></div><div class="home-widgets"><button class="home-widget" data-action="app:calendar"><small>UP NEXT</small><p>${esc(event?.title || 'A little breathing room')}</p><strong>${event ? esc(displayTime(event.start).replace(' PM','')) : '—'}</strong><p>Open Calendar ↗</p></button><button class="home-widget" data-action="app:clock"><small>TAKE YOUR TIME</small>${icon('sun')}<p>Mostly clear.<br>Unlike your notifications.</p></button></div><div class="apps-grid">${APPS.map(launch).join('')}</div><div class="home-dock">${[APPS[0], APPS[2], APPS[5]].map(launch).join('')}</div></div>`;
}
const header = (title, detail = '') => `<div class="app-header"><h2>${title}</h2><span>${detail}</span></div>`;
function screen() {
  const { app, contact } = state.screen;
  if (app === 'home') return home();
  if (app === 'distraction') return distractionScreen(state.distractions[state.screen.distractionId]);
  const thread = c => `<button class="thread-row" data-action="contact:${esc(c)}"><span class="thread-avatar">${esc(contactName(state,c).slice(0,1))}</span><span><strong>${esc(contactName(state,c))}</strong><p>${esc(state.messages[c].at(-1)?.text || 'No messages yet')}</p></span></button>`;
  if (app === 'messages' && !contact) return header('Messages', `${Object.keys(state.messages).length} conversations`) + `<div class="app-body"><div class="mini-toolbar"><button class="mini-button" data-action="message-new">New message</button></div>${searchField('messages',state.searches.messages)}<div class="mini-search-results">${shownThreads(state).map(thread).join('') || '<p class="empty-phone">No conversations found.</p>'}</div></div>`;
  if (app === 'messages') return header(esc(contactName(state,contact)), 'Messages') + `<div class="app-body"><div class="chat-date">Today · 9:41 AM</div>${state.messages[contact].map(m => `<div class="bubble ${m.from === 'you' ? 'outgoing' : ''}">${esc(m.text)}</div>`).join('')}<form class="message-compose" id="message-compose"><textarea data-field="reply" id="phone-reply" rows="2" maxlength="500" aria-label="Message to ${esc(contactName(state,contact))}" placeholder="Message">${esc(state.drafts[contact])}</textarea><button class="send-button" aria-label="Send message" type="submit" ${state.drafts[contact].trim() ? '' : 'disabled'}>↑</button></form><p class="app-subtitle">Messages stay in this simulated phone.</p></div>`;
  const mini = miniScreen(state, header, displayTime);
  if (mini !== null) return mini;
  if (app === 'feed') return '';
  if (app === 'notifications') return header('Notifications', String(state.notifications.length)) + `<div class="app-body">${state.notifications.length ? state.notifications.map(n => `<div class="notification-list-item"><button data-action="notification:${n.id}"><strong>${esc(n.title)}</strong><p>${esc(n.body)}</p>${notificationBait(n.distraction)}</button><button class="text-button" data-action="dismiss:${n.id}">Dismiss</button></div>`).join('') : '<p class="empty-phone">A rare moment of quiet.</p>'}</div>`;
  if (app === 'switcher') return header('Your apps', 'Pick up where you left off') + `<div class="app-body apps-grid">${APPS.map(launch).join('')}</div>`;
  if (app === 'intention') return header('Remember why') + `<div class="app-body"><div class="appointment"><h3>Your original intention</h3><p>${esc(state.scenario.intention)}</p></div><p class="calendar-note">A reminder is allowed. So is doing the thing.</p><button class="button secondary" data-action="back">Back to it →</button></div>`;
  return '';
}
function render() {
  document.body.classList.toggle('in-round', state.phase !== 'ready');
  $('intro').hidden = state.phase !== 'ready';
  $('game-stage').hidden = state.phase === 'ready';
  const root = $('phone-screen');
  root.classList.toggle('is-doom', state.screen.app === 'feed');
  if (state.screen.app === 'feed') {
    if (doomView?.roundId !== state.roundId) { doomView?.destroy(); doomView = null; }
    if (!doomView) doomView = new DoomFeed(root, state, index => {
      while (state.screen.app === 'feed' && state.phase === 'playing' && state.feedIndex !== index && !replayMode) {
        const before = state.feedIndex;
        dispatch({ type:'tap', target:index > before ? 'next-post' : 'previous-post' },true,false);
        if (before === state.feedIndex) break;
      }
      renderTime(); renderOverlay(); renderNotification();
      return state;
    });
    else doomView.update(state);
    doomView.setActive(mode === 'play' && state.phase === 'playing');
  } else {
    doomView?.destroy(); doomView = null;
    const key = JSON.stringify(state.screen);
    const previousScroll = root.dataset.screen === key ? root.scrollTop : 0;
    root.innerHTML = screen(); root.scrollTop = previousScroll; root.dataset.screen = key;
  }
  renderTime(); renderOverlay(); renderNotification();
}
function renderTime() { updateDistractionMotion(state); const remaining = Math.ceil((roundDuration(state.scenario) - state.elapsed) / 1000); $('round-clock').textContent = `${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}`; $('round-clock').classList.toggle('running-low', remaining <= 30); $('notification-count').textContent = state.notifications.length; }
function renderOverlay() {
  let html = '';
  const showTask = state.phase === 'playing' && !revealDismissed && (state.elapsed < RULES.revealMs || state.elapsed < (state.taskRecallUntil || 0));
  const note = showTask ? `<p>${esc(state.scenario.intention)}</p><button id="dismiss-reveal">Got it ↗</button>` : '<p class="task-folded">You came here for one thing.</p>';
  if ($('task-note-content').innerHTML !== note) $('task-note-content').innerHTML = note;
  if (['finished','expired'].includes(state.phase)) html = `<div class="reveal-card"><div class="result-symbol">${state.phase === 'finished' ? '↗' : '↻'}</div><div class="eyebrow">${replayMode ? 'REPLAY · ' : ''}${state.phase === 'finished' ? 'INTENTION KEPT' : 'LOST IN THE PHONE'}</div><h2>${state.phase === 'finished' ? 'You can put it down.' : 'The phone won.'}</h2><p>${state.phase === 'finished' ? esc(state.scenario.success || 'Intention kept.') : 'Your task is still unfinished.'}</p><p>${Math.round(state.elapsed / 1000)}s · ${state.log.length} actions · ${state.recalled} reminders${state.distractionTaps ? ` · ${state.distractionTaps} distraction taps` : ''}</p><button class="button primary" id="next-round">Try another day ↗</button><button class="text-button" id="result-profile">Can your stand-in do it? →</button></div>`;
  if ($('phone-overlay').innerHTML !== html) $('phone-overlay').innerHTML = html;
}
function renderNotification() {
  const blocked = blockingNotification(state);
  const n = blocked || state.notifications.at(-1);
  $('notification-banner').classList.toggle('interrupting', !!blocked);
  $('phone-screen').inert = !!blocked;
  document.querySelector('.phone-navigation').inert = !!blocked;
  const show = n && (blocked || state.elapsed - n.at < 5200) && state.phase === 'playing' && (blocked || state.screen.app !== 'notifications');
  const html = show ? `<div class="notification-toast"><i class="mini-app ${APPS.find(a => a.id === n.app)?.color || 'green'}">↗</i><button class="notification-open" data-action="notification:${n.id}"><strong>${esc(n.title)}</strong><p>${esc(n.body)}</p>${notificationBait(n.distraction)}</button><button class="notification-dismiss" data-action="dismiss:${n.id}" aria-label="Dismiss ${esc(n.title)}">${blocked ? 'Dismiss' : '×'}</button></div>` : '';
  if ($('notification-banner').innerHTML !== html) $('notification-banner').innerHTML = html;
}
async function agentPlay() {
  if (agentRunning) { stopAgent(); toast('Your turn. The stand-in is paused.'); return; }
  if (!mesh.ready && !peer.ready && !local.session) { $('mesh-dialog').showModal(); return; }
  if (race?.id === state.roundId && state.phase === 'playing') state.controller = 'agent'; else newRound('agent'); agentRunning = true; $('agent-round').textContent = 'Watch AI play';
  const roundId = state.roundId;
  const ownerId = agentOwnerId = uuid();
  const matchId = race?.id || roundId;
  try {
    while (agentRunning && state.phase === 'playing' && state.roundId === roundId) {
      const pending = decisions.begin(state, { matchId, controllerId: ownerId });
      const { observation } = pending; requestController = new AbortController();
      const started = performance.now();
      const result = await (mesh.ready ? mesh : peer.ready ? peer : local).generate({ kind: 'action', binding: pending.binding, observation, memory, history: state.log.map(e => ({type:e.action.type,target:e.action.target,...(e.action.value !== undefined ? {value:e.action.value} : {})})), profile: { id: profile.id, objective: profile.objective, version: profile.version, examples: profile.examples.slice(-6) } }, AbortSignal.any([requestController.signal, pending.signal]));
      inferenceMs += performance.now() - started;
      if (!agentRunning || agentOwnerId !== ownerId || state.roundId !== roundId) break;
      const applied = decisions.accept(state, result, { matchId: race?.id || state.roundId, controllerId: agentOwnerId });
      if (!applied.accepted) throw new Error(applied.reason);
      state = applied.state; remember(observe(state)); render();
      $('round-status').textContent = `Stand-in: ${state.log.at(-1).action.target.replace('app:', 'opened ')} · ${mesh.ready ? 'distributed helper' : peer.ready ? 'connected peer' : 'this device'}`;
      if (state.phase === 'finished') complete();
      await new Promise(r => setTimeout(r, 350));
    }
  } catch (error) { if (agentRunning) { report(error); $('round-status').textContent = `${error.message} You can take over.`; } }
  finally { if (agentOwnerId === ownerId) stopAgent(); }
}
function raceSummary() {
  if (!race) return;
  const seconds = x => `${(x.elapsed / 1000).toFixed(1)}s`;
  $('race-status').textContent = race.local && race.remote
    ? `You: ${race.local.finished ? seconds(race.local) : 'unfinished'} · Friend: ${race.remote.finished ? seconds(race.remote) : 'unfinished'}. Friendly comparison; no ranking.`
    : race.remote ? 'Your friend finished. Keep your intention.' : race.local ? 'Your round is saved. Waiting for your friend.' : 'Same task. Two phones. Finish the intention.';
}
function handleGame(message) {
  try {
    if (typeof message.raceId !== 'string' || message.raceId.length > 100) return;
    if (message.type === 'invite' && SCENARIOS.some(s => s.id === message.scenarioId)) {
      if (state.phase === 'playing') { peer.sendGame({type:'declined',raceId:message.raceId}); return; }
      invitation = { id: message.raceId, scenarioId: message.scenarioId }; $('race-invite').hidden = false;
      if (!$('mesh-dialog').open) $('mesh-dialog').showModal(); return;
    }
    if (message.type === 'ready' && race?.id === message.raceId && race.role === 'host' && race.phase === 'waiting') {
      race.phase = 'playing'; peer.sendGame({type:'start',raceId:race.id}); newRound('human',{raceId:race.id,scenario:SCENARIOS.find(s=>s.id===race.scenarioId)}); raceSummary(); return;
    }
    if (message.type === 'start' && race?.id === message.raceId && race.role === 'guest' && race.phase === 'waiting') {
      race.phase = 'playing'; newRound('human',{raceId:race.id,scenario:SCENARIOS.find(s=>s.id===race.scenarioId)}); raceSummary(); return;
    }
    if (!race || race.id !== message.raceId) return;
    if (message.type === 'leave' || message.type === 'declined') { $('race-status').textContent = 'Friend left or declined this round. You can keep playing.'; race = null; return; }
    if (message.type === 'result' && !race.remote) {
      const record = message.record, scenario = SCENARIOS.find(s=>s.id===race.scenarioId);
      if (record?.roundId !== race.id || record.version !== RULES.version || !Array.isArray(record.log) || record.log.length > RULES.maxActions || !Number.isFinite(record.elapsed) || record.elapsed < 0 || record.elapsed > roundDuration(scenario) || record.log.some(e=>!Number.isFinite(e.at)||e.at<0||e.at>record.elapsed)) throw new Error('Invalid peer replay');
      const verified = replay({...record,scenario});
      if (!['finished','expired'].includes(verified.phase)) throw new Error('Peer replay does not finish the task');
      race.remote = {finished:verified.phase==='finished',elapsed:record.elapsed}; raceSummary();
    }
  } catch (error) { report(error); }
}
function renderProfile() {
  $('profile-summary').textContent = `${profile.rounds || 0} completed demonstrations · ${profile.examples.length} remembered decisions · profile v${profile.version}`;
  $('training-objective').value = profile.objective;
  $('demonstration-list').innerHTML = profile.examples.length ? profile.examples.slice(-8).map(e => `<div class="demo-row"><span>${esc(e.observation.screen.app)}</span> → ${esc(e.action.target)}${e.action.value ? `: “${esc(e.action.value.slice(0,100))}”` : ''}</div>`).join('') : '<p class="muted">Complete a round yourself to give your stand-in its first examples. Nothing has been learned yet.</p>';
  $('replay-summary').textContent = lastReplay ? `${lastReplay.log.length} recorded actions. Watch what actually happened, without running inference again.` : 'Your first completed round will appear here.';
  $('replay-round').disabled = !lastReplay; $('export-replay').disabled = !lastReplay;
}
function download(name, data) { const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
const guarded = fn => async event => { try { await fn(event); } catch (error) { report(error); } };
document.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
const toasterEntry = bindToasterEntry(entryRect => newRound('human', { entryRect }));
$('play-human').onclick = () => {
  setMode('play');
  if (state.phase === 'ready') { void toasterEntry.play(); return; }
  toasterEntry.cancel(); stopAgent();
  if (state.phase === 'playing') { state.controller = 'human'; render(); }
  else newRound();
};
$('agent-round').onclick = guarded(async () => { toasterEntry.cancel(); await agentPlay(); });
$('new-round').onclick = () => newRound();
$('import-challenge').onchange = guarded(async event => {
  const file = event.target.files[0]; if (!file) return;
  if (file.size > 200000) throw new Error('Challenge file is too large');
  const value = JSON.parse(await file.text());
  const imported = value.schema ? parseCatalog(value) : [validateChallenge(value)];
  if (imported.some(c => SCENARIOS.some(s => s.id === c.id))) throw new Error('Use new challenge IDs; existing rounds keep their original config.');
  SCENARIOS.push(...imported); renderChallengeMenu(); $('challenge-select').value = imported[0].id;
  newRound('human', { scenario:imported[0] }); event.target.value = '';
});
$('site-menu').querySelectorAll('button').forEach(button => button.addEventListener('click', () => { $('site-menu').open = false; }));
document.addEventListener('keydown', event => { if (event.key === 'Escape') $('site-menu').open = false; });
document.addEventListener('click', event => { if (!$('site-menu').contains(event.target)) $('site-menu').open = false; });
$('remember').onclick = () => { revealDismissed = false; if (state.phase === 'ready') newRound(); else dispatch({ type: 'tap', target: 'recall' }); };
$('task-note-content').onclick = event => { if (event.target.closest('#dismiss-reveal')) { revealDismissed = true; renderOverlay(); } };
$('phone-back').onclick = () => dispatch({ type: 'tap', target: 'back' }); $('phone-home').onclick = () => dispatch({ type: 'tap', target: 'home' }); $('phone-switcher').onclick = () => dispatch({ type: 'tap', target: 'switcher' });
$('soundless-notifications').onclick = () => dispatch({ type: 'tap', target: 'notifications' });
$('phone').addEventListener('click', e => {
  const control = e.target.closest('[data-action]'); if (control) dispatch({ type: 'tap', target: control.dataset.action });
  if (e.target.closest('#dismiss-reveal')) { revealDismissed = true; renderOverlay(); }
  if (e.target.closest('#next-round')) newRound();
  if (e.target.closest('#result-profile')) setMode('train');
});
$('phone').addEventListener('input', e => {
  if (!e.target.dataset.field) return;
  dispatch({ type: 'type', target: e.target.dataset.field, value: e.target.value }, true, false);
  if (e.target.dataset.field.startsWith('search-')) {
    const results = document.createElement('div'); results.innerHTML = screen();
    const current = $('phone-screen').querySelector('.mini-search-results');
    if (current) current.innerHTML = results.querySelector('.mini-search-results').innerHTML;
  }
  const send = $('message-compose')?.querySelector('button'); if (send) send.disabled = !state.drafts[state.screen.contact]?.trim();
});
$('phone').addEventListener('submit', e => { if (e.target.id === 'message-compose') { e.preventDefault(); dispatch({ type: 'tap', target: 'send' }); } });
$('train-play').onclick = () => newRound(); $('watch-agent').onclick = guarded(agentPlay);
$('training-objective').onchange = e => { profile.objective = e.target.value; profile.version++; save('muzil.profile.v1',profile); renderProfile(); };
$('export-profile').onclick = () => download('meta-muzil-profile.json',profile);
$('clear-profile').onclick = () => { profile = { schema: 'muzil.profile/v1', id: uuid(), version: 1, objective: 'finish', rounds: 0, examples: [] }; save('muzil.profile.v1',profile); renderProfile(); toast('Demonstrations forgotten.'); };
$('import-profile').onchange = guarded(async e => {
  const file = e.target.files[0]; if (!file) return; if (file.size > 200000) throw new Error('Profile is too large');
  const p = JSON.parse(await file.text());
  if (p.schema !== 'muzil.profile/v1' || !['finish','imitate'].includes(p.objective) || !Array.isArray(p.examples) || p.examples.length > 36 || !Number.isSafeInteger(p.version) || p.version < 1 || !Number.isSafeInteger(p.rounds) || p.rounds < 0 || p.examples.some(e => !e.observation?.screen?.app || !Array.isArray(e.observation.actions) || !['tap','type'].includes(e.action?.type) || typeof e.action.target !== 'string')) throw new Error('Unsupported profile');
  profile = { schema: p.schema, id: typeof p.id === 'string' ? p.id.slice(0,100) : uuid(), version: p.version, rounds: p.rounds, objective: p.objective, examples: p.examples }; save('muzil.profile.v1',profile); renderProfile(); toast('Profile imported.');
});
$('replay-round').onclick = guarded(() => { stopAgent(); replayMode = true; replayStarted = performance.now(); state = replay(lastReplay,0); setMode('play'); $('round-status').textContent = 'Recorded replay. No new inference.'; render(); });
$('export-replay').onclick = () => { if (lastReplay) download('meta-muzil-replay.json',lastReplay); };
$('race-peer').onclick = guarded(() => {
  toasterEntry.cancel();
  if (peer.state !== 'connected') { $('mesh-dialog').showModal(); return; }
  if (state.phase === 'playing') throw new Error('Finish this round before inviting a friend.');
  race = {id:uuid(),scenarioId:selectedChallenge().id,role:'host',phase:'waiting'};
  peer.sendGame({type:'invite',raceId:race.id,scenarioId:race.scenarioId}); $('race-status').textContent = 'Invitation sent. Waiting for your friend.';
});
$('accept-race').onclick = guarded(() => {
  if (!invitation) return; race = {...invitation,role:'guest',phase:'waiting'}; invitation = null; $('race-invite').hidden = true; $('mesh-dialog').close();
  peer.sendGame({type:'ready',raceId:race.id}); $('race-status').textContent = 'Ready. Waiting for the round to start.';
});
$('connection').onclick = () => { updateConnection(); $('mesh-dialog').showModal(); }; $('about-button').onclick = () => $('about-dialog').showModal();
document.querySelectorAll('.close-dialog').forEach(b => b.onclick = () => b.closest('dialog').close());
async function pairing(fn) { $('mesh-error').textContent = ''; try { await fn(); } catch (e) { $('mesh-error').textContent = e.message; } }
$('make-offer').onclick = () => pairing(async () => { $('peer-output').value = 'Preparing connection…'; await peer.connect(true); $('peer-output').value = await peer.exportCode(); });
$('join-offer').onclick = () => pairing(async () => { const code = $('peer-input').value; if (!code.trim()) throw new Error('Paste the other device’s connection code first.'); await peer.connect(false); await peer.acceptCode(code); $('peer-output').value = await peer.exportCode(); });
$('accept-answer').onclick = () => pairing(async () => { await peer.acceptCode($('peer-input').value); });
$('disconnect-peer').onclick = guarded(() => peer.close());
$('copy-code').onclick = guarded(async () => { await navigator.clipboard.writeText($('peer-output').value); toast('Connection code copied.'); });
$('load-model').onclick = async () => {
  $('load-model').disabled = true; $('mesh-error').textContent = '';
  try { await local.prepare(status => { $('model-state').textContent = String(status); }); updateConnection(); peer.announce(); }
  catch (error) { $('model-state').textContent = 'Model unavailable'; $('mesh-error').textContent = error.message; }
  finally { $('load-model').disabled = !!local.session; }
};
$('share-compute').onchange = () => { peer.sharing = $('share-compute').checked; peer.announce(); };
$('unload-model').onclick = guarded(async () => { peer.sharing = false; $('share-compute').checked = false; peer.announce(); await local.close(); $('load-model').disabled = false; $('model-state').textContent = 'Model not loaded'; updateConnection(); });
$('reply-form').onsubmit = guarded(async e => {
  e.preventDefault(); const message = $('real-message').value.trim(), context = $('real-context').value.trim();
  if (!message || !context) throw new Error('Add the message and the relevant details first.');
  const remote = mesh.ready || peer.ready;
  if (remote && !$('reply-consent').checked) throw new Error('Approve sharing this message with the connected peer first.');
  if (!remote && !local.session) { $('mesh-dialog').showModal(); return; }
  $('draft-reply').disabled = true; $('reply-status').textContent = remote ? 'Preparing your reply on the connected peer…' : 'Preparing your reply on this device…';
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(),45000);
  try { const result = await (mesh.ready ? mesh : remote ? peer : local).generate({ kind: 'reply', message, context },controller.signal); $('reply-output').value = result.text; $('reply-status').textContent = 'Check the details, edit if needed, then copy. Nothing has been sent.'; }
  catch (error) { $('reply-status').textContent = error.message; }
  finally { clearTimeout(timer); $('draft-reply').disabled = false; }
});
$('copy-reply').onclick = guarded(async () => { if (!$('reply-output').value.trim()) throw new Error('There is no reply to copy yet.'); await navigator.clipboard.writeText($('reply-output').value); toast('Reply copied. You choose where to send it.'); });
interval = setInterval(() => {
  if (replayMode) { const at = performance.now() - replayStarted; state = replay(lastReplay,at); render(); if (at >= lastReplay.elapsed) replayMode = false; return; }
  if (state.phase !== 'playing') return;
  const prevCount = state.notifications.length; state = advance(state,performance.now() - roundStarted);
  renderTime(); renderOverlay(); renderNotification();
  if (state.notifications.length !== prevCount) remember(observe(state));
  if (state.phase === 'expired') { complete(); render(); }
},250);
window.addEventListener('pagehide', () => { clearInterval(interval); doomView?.destroy(); stopAgent(); void peer.close(); });
render(); updateConnection();

let partitionLink = null;
$('partition-offer').onclick = () => pairing(async () => {
  partitionLink = await mesh.connect(true, $('partition-kind').value);
  $('partition-output').value = await partitionLink.exportCode();
});
$('partition-join').onclick = () => pairing(async () => {
  partitionLink = await mesh.connect(false, $('partition-kind').value);
  partitionLink.acceptCode($('partition-input').value);
  $('partition-output').value = await partitionLink.exportCode();
});
$('partition-answer').onclick = () => pairing(async () => { if (!partitionLink) throw new Error('Create a connection first'); partitionLink.acceptCode($('partition-input').value); });
$('partition-copy').onclick = guarded(() => navigator.clipboard.writeText($('partition-output').value));
$('prepare-a').onclick = () => pairing(() => mesh.prepare(0));
$('prepare-b').onclick = () => pairing(() => mesh.prepare(1));
$('partition-drain').onclick = () => pairing(() => mesh.drain());
$('partition-disconnect').onclick = () => pairing(async () => { stopAgent(); await mesh.close(); updateConnection(); });
$('partition-evidence').onclick = () => download('muzil-execution.json', { ...mesh.metrics, actions: decisions.receipts });
