// Session controls belong to the running script. A cached HTML document may
// predate them, so mount them before binding handlers or preparing controllers.
export function preparePageShell(document) {
  const byId=id=>document.getElementById(id);
  const button=(id,label,className='')=>{
    const node=document.createElement('button');
    node.id=id;node.type='button';node.textContent=label;node.className=className;
    return node;
  };
  let controls=byId('round-controls');
  if(!controls){
    controls=document.createElement('div');controls.id='round-controls';
    controls.className='round-controls';controls.hidden=true;
    byId('game-stage').querySelector('.phone-caption').before(controls);
  }
  for(const [id,label] of [['pause-round','Pause'],['leave-round','Leave']]){
    if(!byId(id))controls.append(button(id,label));
  }
  if(!byId('watch-replay')){
    const replay=button('watch-replay','Watch replay','nav-item');replay.disabled=true;
    byId('agent-round').after(replay);
  }
  // Keep navigation current when new code meets the previously cached shell.
  const footer=document.querySelector('.site-footer > div');
  const duel=footer.querySelector('a[href="/history"]');
  duel.textContent='Play Meta Duel instead ↗';
  if(!footer.querySelector('a[href="/mandate-2038/"]')){
    const boardgame=document.createElement('a');boardgame.href='/mandate-2038/';
    boardgame.textContent='Play a meta boardgame ↗';duel.after(boardgame);
  }
}
