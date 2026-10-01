import { DISTRACTIONS, timingPosition } from './distractions.mjs';
export function distractionScreen(game) {
  const copy = DISTRACTIONS[game.kind];
  if (game.required && game.chainStage === 'replies') return `<div class="bait-app bait-thread"><div class="bait-eyebrow">MESSAGES <span>now</span></div><h2>The group chat</h2><div class="bait-comment"><strong>Lila</strong><p>That is absolutely your face.</p></div><div class="bait-comment"><strong>Noor</strong><p>Wait until you see the original. React first.</p></div><p class="bait-hint">React to the post</p>${[['laugh','That got me 😂'],['same','Literally me 🫠'],['nope','Absolutely not 🙃']].map(([id,label])=>`<button class="bait-primary" data-action="bait:react:${id}">${label}</button>`).join('')}</div>`;
  if (game.required && game.chainStage === 'source') return `<div class="bait-app bait-thread"><div class="bait-eyebrow">MESSAGES <span>now</span></div><h2>Noor sent a link</h2><div class="bait-comment"><strong>Noor</strong><p>The original is even better. Read the next bit.</p></div><div class="bait-link-preview"><span>↗</span><strong>JUST ONE MORE</strong><p>The post everyone is talking about</p></div><button class="bait-primary" data-action="bait:source">Open the original post ↗</button></div>`;
  let play = '';
  if (game.kind === 'reveal') play = `<div class="bait-photo"><div class="bait-pigeon"><span>◉</span><b>⌁</b><i>you, apparently</i></div><div class="bait-shutters">${[0,1,2].map(i=>`<button data-action="bait:tile:${i}" aria-label="Reveal photo tile ${i+1}" ${game.open.includes(i)?'disabled class="revealed"':''}><span>?</span><small>TAP TO REVEAL</small></button>`).join('')}</div></div><p class="bait-progress">${game.open.length} of 3 revealed</p>`;
  if (game.kind === 'pairs') play = `<div class="bait-cards">${game.cards.map((shape,i)=>{const matched=game.matched.includes(i),shown=game.open.includes(i)||matched;return `<button data-action="bait:tile:${i}" aria-label="Card ${i+1}${shown?': '+shape:''}" class="${matched?'matched':shown?'flipped':''}" ${shown?'disabled':''}>${shown?shape:'✦'}</button>`;}).join('')}</div><p class="bait-progress">${game.matched.length/2} of 3 pairs · ${game.taps} taps</p>${game.open.length===2?'<button class="bait-primary" data-action="bait:reset">Try another pair ↻</button>':''}`;
  if (game.kind === 'timing') play = `<div class="bait-timing"><span class="bait-target"></span><span class="bait-marker" id="bait-marker"></span></div><p class="bait-progress" id="bait-timing-status">${game.stopped===null?'One tap. Right there.':game.done?'Exactly right.':`Stopped at ${Math.round(game.stopped)}%. ${Math.abs(game.stopped-50)<25?'So close.':'Again?'}`}</p>${game.stopped===null?'<button class="bait-primary" data-action="bait:stop">STOP</button>':''}`;
  const retry = !game.required && (game.done || (game.kind==='timing' && game.stopped!==null));
  return `<div class="bait-app"><div class="bait-eyebrow">JUST ONE THING <span>↗</span></div><h2>${copy.title}</h2><p class="bait-hint">${copy.hint}</p>${play}${game.done?`<div class="bait-reward"><span>✧</span><p>${copy.reward}</p><small>+1 utterly useless achievement</small></div>`:''}${retry?`<button class="bait-primary" data-action="bait:again">${game.done?'One more round →':'Try again ↻'}</button>`:''}${game.required ? ((game.done || (game.kind==='timing' && game.stopped!==null)) ? '<button class="bait-primary" data-action="bait:replies">See what everyone said →</button>' : '') : '<button class="bait-leave" data-action="bait:leave">Back to what I was doing</button><p class="bait-clock-note">Your original task is still waiting.</p>'}</div>`;
}
let timingFrame = 0, timingSnapshot = null;
export function updateDistractionMotion(state) {
  const marker = document.getElementById('bait-marker');
  const game = state.distractions?.[state.screen.distractionId];
  if (!marker || !game) { cancelAnimationFrame(timingFrame); timingFrame = 0; timingSnapshot = null; return; }
  timingSnapshot = { marker, game, elapsed:state.elapsed, at:performance.now(), playing:state.phase === 'playing' };
  marker.style.left = `${timingPosition(game,state.elapsed)}%`;
  if (timingFrame || game.stopped !== null || !timingSnapshot.playing) return;
  function paint(now) {
    timingFrame = 0;
    const s = timingSnapshot;
    if (!s?.marker.isConnected || document.hidden) return;
    // Use the same elapsed clock that action dispatch samples, without waiting
    // for the UI's 250ms countdown refresh to move the timing-game marker.
    s.marker.style.left = `${timingPosition(s.game,s.elapsed + (s.playing ? now - s.at : 0))}%`;
    if (s.playing && s.game.stopped === null) timingFrame = requestAnimationFrame(paint);
  }
  timingFrame = requestAnimationFrame(paint);
}
export function notificationBait(kind) {
  if (!DISTRACTIONS[kind]) return '';
  const visual = kind === 'reveal' ? '<span class="bait-thumb">◉<i>?</i></span>' : kind === 'pairs' ? '<span class="bait-mini-cards">✦ ✦<br>✦ ✦</span>' : '<span class="bait-mini-timing">▰<i>│</i></span>';
  return `<span class="notification-bait ${kind}">${visual}<span>${kind==='reveal'?'Is that you?':kind==='pairs'?'Bet you can’t leave it unfinished.':'You get one perfect tap.'}<b>${kind==='reveal'?'Reveal photo':kind==='pairs'?'Find the pairs':'Try it'} ↗</b></span></span>`;
}
