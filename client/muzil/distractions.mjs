export const DISTRACTIONS = Object.freeze({
  reveal: { title:'Wait. Is that you?', teaser:'Three tiles are hiding the photo. You were tagged.', hint:'Tap the tiles to see what they posted.', reward:'It was a pigeon wearing your exact expression.' },
  pairs: { title:'You can finish this.', teaser:'Six cards. Three pairs. Surely ten seconds.', hint:'Find the three matching pairs.', reward:'Perfect matches. Completely unrelated to your task.' },
  timing: { title:'One perfect tap.', teaser:'Stop it in the tiny green zone. It looks easy.', hint:'Tap STOP when the marker crosses the green zone.', reward:'Perfect. Your timing has no practical application.' },
});
const shapes = ['✳', '◈', '◎'];
export function newDistraction(kind, seed, elapsed, attempt = 0, required = false) {
  let hash = 2166136261;
  for (const char of `${seed}:${attempt}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const cards = [...shapes, ...shapes];
  for (let i = cards.length - 1; i > 0; i--) { hash = (Math.imul(hash,1664525) + 1013904223) >>> 0; const j = hash % (i + 1); [cards[i],cards[j]] = [cards[j],cards[i]]; }
  return { kind, seed, attempt, required, chainStage:'game', reaction:null, sourceOpened:false, cards, open:[], matched:[], taps:0, done:false, startedAt:elapsed, stopped:null };
}
export const timingPosition = (game, elapsed) => game.stopped ?? Math.abs(((elapsed - game.startedAt) % 2200) / 1100 - 1) * 100;
export function distractionObservation(game, elapsed) {
  if(game.decision) return decisionObservation(game,elapsed);
  const copy = DISTRACTIONS[game.kind], text = [copy.title, copy.hint], actions = [];
  const add = (target,label) => actions.push({type:'tap',target,label});
  if (game.required && game.chainStage === 'replies') {
    text.push('The group chat', 'Lila: That is absolutely your face.', 'Noor: Wait until you see the original. React first.', 'React to the post');
    for (const [id,label] of [['laugh','That got me 😂'],['same','Literally me 🫠'],['nope','Absolutely not 🙃']]) add(`bait:react:${id}`,label);
    return {text,actions};
  }
  if (game.required && game.chainStage === 'source') {
    text.push('Noor sent a link', `Your reaction: ${game.reaction}`, 'The original is even better. Read the next bit.'); add('bait:source','Open the original post in Doom Scroll'); return {text,actions};
  }
  if (game.required && (game.done || (game.kind === 'timing' && game.stopped !== null))) {
    text.push(game.done ? copy.reward : `Stopped at ${Math.round(game.stopped)}%. The group has thoughts.`); add('bait:replies','See what everyone said');
  } else if (game.done) { text.push(copy.reward); add('bait:again','One more round'); }
  else if (game.kind === 'reveal') {
    text.push(`${game.open.length}/3 photo tiles revealed`);
    for (let i=0; i<3; i++) if (!game.open.includes(i)) add(`bait:tile:${i}`,`Reveal photo tile ${i+1}`);
  } else if (game.kind === 'pairs') {
    text.push(`${game.matched.length/2}/3 pairs found`);
    for (let i=0; i<6; i++) {
      const shown = game.open.includes(i) || game.matched.includes(i);
      text.push(`Card ${i+1}: ${shown ? game.cards[i] : 'face down'}`);
      if (!shown) add(`bait:tile:${i}`,`Turn over card ${i+1}`);
    }
    if (game.open.length === 2) add('bait:reset','Try another pair');
  } else if (game.stopped !== null) {
    text.push(`Stopped at ${Math.round(game.stopped)}%; target 43–57%.`); add('bait:again','Try again');
  } else { text.push(`Marker at ${Math.round(timingPosition(game,elapsed))}%; target 43–57%.`); add('bait:stop','Stop the marker'); }
  if (!game.required) add('bait:leave','Back to what I was doing');
  return {text,actions};
}
export function actOnDistraction(game, target, elapsed) {
  if (target === 'bait:again') return newDistraction(game.kind, game.seed, elapsed, game.attempt + 1, game.required);
  game.taps++;
  if (target === 'bait:replies') game.chainStage = 'replies';
  if (target.startsWith('bait:react:')) { game.reaction = target.slice(11); game.chainStage = 'source'; }
  if (target === 'bait:reset') game.open = [];
  if (target.startsWith('bait:tile:')) {
    const index = Number(target.split(':').at(-1));
    if (game.kind === 'pairs' && game.open.length === 2) game.open = [];
    game.open.push(index);
    if (game.kind === 'reveal') game.done = game.open.length === 3;
    else if (game.open.length === 2 && game.cards[game.open[0]] === game.cards[game.open[1]]) {
      game.matched.push(...game.open); game.open = []; game.done = game.matched.length === 6;
    }
  }
  if (target === 'bait:stop') { game.stopped = timingPosition(game,elapsed); game.done = game.stopped >= 43 && game.stopped <= 57; }
  return game;
}

// Decision interruptions use a separate version so old replay chains remain exact.
export function decisionDistraction(n, seed, elapsed) {
  return {...newDistraction(n.distraction || 'reveal',seed,elapsed,0,true),decision:true,
    interaction:n.interaction || 'media',notification:n,title:n.title,detail:n.detail || n.body,
    stage:'choose',readyAt:elapsed,resolution:null,completed:false};
}
export function decisionObservation(g, elapsed) {
  const text=[g.title],actions=g.required?[]:[{type:'tap',target:'bait:leave',label:'Back to my task'}],add=(target,label)=>actions.push({type:'tap',target,label});
  if(g.stage==='wait') {
    text.push(g.resolution,elapsed<g.readyAt?`Continue in ${Math.ceil((g.readyAt-elapsed)/1000)} seconds.`:g.detail);
    if(elapsed>=g.readyAt)add('bait:finish','Return to the phone');
  } else if(g.interaction==='call') {
    text.push('Incoming call. Answer for the full update, or decline and read the voicemail.');
    add('bait:voicemail','Decline and read voicemail');add('bait:answer','Answer and listen');
  } else if(g.interaction==='group') {
    text.push(g.detail);
    if(!g.notification.followup) {add('bait:vague','Sure, maybe!');add('bait:postpone','Ask me again in a moment');}
    add('bait:clear','I cannot join. I am arranging my pickup.');
  } else if(g.interaction==='conflict') {
    text.push(g.detail,'Your draft will stay as you left it.');
    add('bait:retain','Keep working from my previous plan');add('bait:inspect',g.notification.app==='messages'?'Read the clinic update':'Inspect the updated appointment');
  } else if(g.interaction==='timing') {
    text.push(`An accurate stop lets you leave immediately. A miss costs ${(g.notification.resolutionTimingMs?.miss ?? 4000)/1000} seconds.`);
    if(g.stopped===null) {text.push(`Marker at ${Math.round(timingPosition(g,elapsed))}%; target 43–57%.`);add('bait:stop','Stop the marker');add('bait:long-exit',`Wait ${(g.notification.resolutionTimingMs?.longExit ?? 6000)/1000} seconds and leave`);}
    else add('bait:finish','Return to the phone');
  } else if(g.done) {
    text.push(DISTRACTIONS[g.kind].reward);add('bait:finish','Back to my task');add('bait:source','Keep reading in Doom Scroll');
  } else {
    const view=distractionObservation({...g,decision:false,required:false},elapsed);
    text.push(...view.text);actions.push(...view.actions.filter(a=>a.target!=='bait:leave'));
  }
  return {text,actions};
}
export function actOnDecision(g,target,elapsed) {
  g.taps++;
  if(['bait:leave','bait:finish','bait:source','bait:clear','bait:vague','bait:postpone','bait:inspect','bait:retain'].includes(target)) {g.completed=true;g.resolution=target.slice(5);return g;}
  if(target==='bait:answer' || target==='bait:voicemail') {
    g.route=target==='bait:answer'?'answer':'voicemail';
    g.stage='wait';g.readyAt=elapsed+(target==='bait:answer'?(g.notification.resolutionTimingMs?.answer ?? 4000):(g.notification.resolutionTimingMs?.voicemail ?? 0));
    g.resolution=target==='bait:answer'?'Listening…':g.notification.voicemail || 'Read the latest message for the update.';
    if(target==='bait:voicemail') g.detail=g.resolution;
  } else if(target==='bait:stop' || target==='bait:long-exit') {
    if(target==='bait:stop') {g.stopped=timingPosition(g,elapsed);g.done=g.stopped>=43&&g.stopped<=57;}
    g.stage='wait';g.readyAt=elapsed+(g.done?0:target==='bait:stop'?(g.notification.resolutionTimingMs?.miss ?? 4000):(g.notification.resolutionTimingMs?.longExit ?? 6000));
    g.resolution=g.done?'Perfect stop. You can go.':target==='bait:stop'?'Missed. Wait for the clip to end.':'Taking the longer exit.';
    g.detail=g.resolution;
  } else actOnDistraction(g,target,elapsed);
  return g;
}
