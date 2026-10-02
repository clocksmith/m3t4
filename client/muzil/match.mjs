import { generateChallenge, FAMILIES } from './task-templates.mjs';
import { replay } from './engine.mjs';
import { roundResult } from './round-report.mjs';
import { RULES } from './scenarios.mjs';
const identity = x => typeof x==='string' && x.length>0 && x.length<=100;
export function compareResults(a,b) {
  if(a.finished!==b.finished)return a.finished?1:-1;
  if(a.finished)return Math.sign(b.elapsed-a.elapsed);
  return Math.sign(a.obligations-b.obligations) || Math.sign(b.mistakes-a.mistakes);
}
// Owns series identity, readiness, replay validation and score. Transport stays Reploid's.
export function createMatchOwner({send,onChange=()=>{},onStart=()=>{},onInvite=()=>{},onOpponentFinished=()=>{},templates,now=()=>Date.now(),id=()=>crypto.randomUUID()}) {
  let match=null, invitation=null;
  const changed=()=>onChange(match);
  const scenario=()=>generateChallenge(templates.find(t=>t.family===FAMILIES[match.round]),`${match.seed}:${match.round}`);
  const roundId=()=>`${match.id}:${match.round}`;
  const packet=(type,extra={})=>send({type,protocol:'muzil-match/1',raceId:match.id,round:match.round,...extra});
  function begin(role,offer) {
    match={id:offer.raceId,seed:offer.seed,role,round:0,phase:'waiting',score:[0,0],ready:[false,false],results:[null,null],opponent:'playing',history:[]};
  }
  function countdown() {
    if(match?.role!=='host'||!match.ready.every(Boolean)||!['waiting','intermission'].includes(match.phase))return;
    match.startAt=now()+3000;match.phase='countdown';packet('countdown',{startAt:match.startAt});changed();
  }
  function finish() {
    if(match.phase!=='playing'||!match.results.every(Boolean))return;
    const result=compareResults(...match.results);
    if(result>0)match.score[0]++;else if(result<0)match.score[1]++;
    match.history.push({round:match.round,results:structuredClone(match.results),winner:result});
    match.phase=match.score.some(s=>s>=2)||match.round===2?'finished':'intermission';
    match.ready=[false,false];changed();
  }
  function validate(record, local=true) {
    const c=scenario();
    if(record?.roundId!==roundId()||record.version!==RULES.version||!Array.isArray(record.log)||record.log.length>RULES.maxActions+RULES.maxEdits||!Number.isFinite(record.elapsed)||record.elapsed<0||record.elapsed>c.durationMs)throw new Error('Invalid peer replay');
    const state=replay({...record,scenario:c});
    if(!['finished','expired'].includes(state.phase) && !(state.phase==='lost' && match.results[local?1:0]?.finished))throw new Error('Peer replay does not finish the round');
    if(JSON.stringify(record.directorEvents)!==JSON.stringify(state.director.events))throw new Error('Peer director record does not match replay');
    return roundResult(state);
  }
  function ready() {
    if(!match||!['waiting','intermission'].includes(match.phase)||match.ready[0])return;
    match.ready[0]=true;packet('ready');advanceRound();countdown();changed();
  }
  function advanceRound() {
    if(match.phase==='intermission'&&match.ready.every(Boolean)) {match.round++;match.results=[null,null];match.phase='waiting';match.opponent='playing';}
  }
  return {
    get current(){return match;},
    invite() {
      if(match&&!['finished','disconnected'].includes(match.phase))throw new Error('A match is already active');
      begin('host',{raceId:id(),seed:id()});match.ready[0]=true;
      packet('invite',{seed:match.seed});changed();
    },
    accept() {if(!invitation)return;begin('guest',invitation);match.ready[1]=true;invitation=null;ready();},
    ready,
    leave() {try{if(match)packet('leave');}catch{/* Transport may already be gone. Local departure still completes. */}match=null;invitation=null;changed();},
    disconnect() {if(invitation){invitation=null;onInvite(null);}if(match){match.phase='disconnected';match.opponent='disconnected';changed();}},
    status(value) {if(match?.phase==='playing'&&['playing','interrupted','finished'].includes(value)&&value!==match.localStatus){match.localStatus=value;packet('status',{status:value});}},
    complete(record) {
      if(match?.phase!=='playing'||match.results[0])return;
      match.results[0]=validate(record);packet('result',{record});finish();changed();
    },
    tick() {
      if(match?.phase==='countdown'&&now()>=match.startAt) {match.phase='playing';match.localStatus=null;onStart({roundId:roundId(),scenario:scenario(),lateMs:Math.max(0,now()-match.startAt)});changed();}
    },
    receive(message, busy=false) {
      if(message?.protocol!=='muzil-match/1'||!identity(message.raceId))return;
      if(message.type==='leave' && invitation?.raceId===message.raceId){invitation=null;onInvite(null);return;}
      if(message.type==='invite') {
        if(!identity(message.seed)||busy||match&&!['finished','disconnected'].includes(match.phase)){send({...message,type:'declined'});return;}
        invitation=message;onInvite(message);return;
      }
      if(!match||message.raceId!==match.id||message.round!==match.round)return;
      if(message.type==='leave'||message.type==='declined'){match.phase='disconnected';match.opponent='disconnected';changed();return;}
      if(message.type==='ready'&&['waiting','intermission'].includes(match.phase)){match.ready[1]=true;advanceRound();countdown();changed();return;}
      if(message.type==='countdown'&&match.role==='guest'&&match.phase==='waiting'&&match.ready[0]) {
        if(!Number.isFinite(message.startAt)||Math.abs(message.startAt-now())>10000)throw new Error('Match countdown clock differs; check device clocks');
        match.startAt=message.startAt;match.phase='countdown';changed();return;
      }
      if(message.type==='status'&&match.phase==='playing'&&['playing','interrupted','finished'].includes(message.status)){match.opponent=message.status;changed();return;}
      if(message.type==='result'&&match.phase==='playing'&&!match.results[1]){match.results[1]=validate(message.record,false);match.opponent='finished';if(match.results[1].finished&&!match.results[0])onOpponentFinished();finish();changed();}
    },
  };
}
