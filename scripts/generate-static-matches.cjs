#!/usr/bin/env node
// Explicit featured archive generation from a local, complete roster snapshot.
// Background evaluations use evaluate-fighter-roster.mjs and are NOT featured.
// No Firestore query, live rating write, deletion or deployment occurs here.
// Example: node scripts/generate-static-matches.cjs --roster=data/m3t4.json \
//   --count=48 --seed=260122 --start=1792670400000
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [k,...v]=arg.replace(/^--/,'').split('=');return [k,v.length?v.join('='):true]}));
const ROOT=path.resolve(__dirname,'..');
const COUNT=Number(args.count??48),SEED=Number(args.seed??260122),T0=Number(args.start??1792670400000);
const OUTPUT=path.resolve(args.output??path.join(ROOT,'client/matches'));
(async()=>{
 if(!Number.isInteger(COUNT)||COUNT<1||COUNT>1000)throw Error('--count must be an integer from 1 to 1000');
 if(!Number.isInteger(SEED)||SEED<0||SEED>0xffffffff)throw Error('--seed must be uint32');
 if(!Number.isSafeInteger(T0)||T0<0)throw Error('--start must be a nonnegative safe integer timestamp');
 const {runMatch,selectBackgroundPair,evaluationFighterKey,evaluationSeed,BACKGROUND_HISTORY_LIMIT}=await import('../match-engine/dist/index.js');
 const {BEHAVIOR_VERSION,RULES_VERSION,STAGES}=await import('../sim/dist/index.js');
 const {migrateFighterRoster}=await import('../client/lib/fighter-roster.mjs');
 const file=path.resolve(args.roster??path.join(ROOT,'data/m3t4.json'));
 const source=JSON.parse(await fs.readFile(file,'utf8'));
 if(!source.stables||typeof source.stables!=='object')throw Error('--roster requires a full saved store with stables');
 const pool=[];
 for(const [id,original]of Object.entries(source.stables)){
  if(original.userId!==id)throw Error('roster owner identity does not match its key');
  const stable=migrateFighterRoster(original,BEHAVIOR_VERSION);
  for(let slotIdx=0;slotIdx<(stable.slots??[]).length;slotIdx++){
   const slot=stable.slots[slotIdx];if(!slot)continue;
   if(!slot.slotId||!slot.config)throw Error(`saved fighter ${id}/${slotIdx} lacks identity or combat config`);
   pool.push({userId:id,handle:stable.handle,slotIdx,slotId:slot.slotId,slotName:slot.name,config:slot.config,cosmetics:slot.cosmetics,
    elo:slot.elo??1500,isHuman:!id.startsWith('system:'),lastPlayedAt:slot.lastPlayedAt??0,
    gamesPlayed:(slot.wins??0)+(slot.losses??0)+(slot.draws??0),evaluations:0,style:slot.config.id});
  }
 }
 if(pool.length<2)throw Error('need at least 2 fighters');
 if(COUNT<Math.ceil(pool.length/2))throw Error('--count is too small to cover every saved fighter');
 pool.sort((a,b)=>{const x=evaluationFighterKey(a),y=evaluationFighterKey(b);return x<y?-1:x>y?1:0});
 const byKey=new Map(pool.map(f=>[evaluationFighterKey(f),f]));
 const sourceHash=crypto.createHash('sha256').update(JSON.stringify(pool)).digest('hex');
 const history=[],summaries=[],covered=new Set();let cursor=T0;
 const stages=Object.keys(STAGES).sort();
 await fs.mkdir(OUTPUT,{recursive:true});
 for(let i=0;i<COUNT;i++){
  const selection=selectBackgroundPair({fighters:pool,history,seed:SEED,sequence:i});
  if(!selection)throw Error('no legal cross-owner pairing exists');
  const a=byKey.get(selection.a),b=byKey.get(selection.b);
  const matchId=`static-v${BEHAVIOR_VERSION}-r${RULES_VERSION}-${T0.toString(36)}-${SEED.toString(36)}-${sourceHash.slice(0,8)}-${i.toString(36).padStart(3,'0')}`;
  const {match}=runMatch({matchId,pair:{a,b},stageId:stages[i%stages.length],startedAt:T0+evaluationSeed(SEED,i,'featured')});
  const virtualStartedAt=cursor,virtualEndsAt=cursor+match.durationMs;cursor=virtualEndsAt;
  const enriched={...match,virtualStartedAt,virtualEndsAt,featured:true,
   provenance:{kind:'static-featured-generation',scheduleSeed:SEED,sequence:i,rosterSha256:sourceHash,selection}};
  const destination=path.join(OUTPUT,`${matchId}.json`),bytes=JSON.stringify(enriched);
  try{await fs.writeFile(destination,bytes,{flag:'wx'})}catch(error){if(error.code!=='EEXIST')throw error;if(await fs.readFile(destination,'utf8')!==bytes)throw Error(`refusing to overwrite different archived match ${matchId}`)}
  summaries.push({matchId,stageId:match.stageId,virtualStartedAt,virtualEndsAt,durationMs:match.durationMs,
   a:{handle:match.a.handle,slotName:match.a.slotName,isHuman:match.a.isHuman,eloBefore:match.a.eloBefore},
   b:{handle:match.b.handle,slotName:match.b.slotName,isHuman:match.b.isHuman,eloBefore:match.b.eloBefore},winner:match.result.winner});
  for(const f of[a,b]){f.evaluations++;f.gamesPlayed++;covered.add(evaluationFighterKey(f))}
  history.push({sequence:i,a:selection.a,b:selection.b});if(history.length>BACKGROUND_HISTORY_LIMIT)history.shift();
 }
 if(covered.size!==pool.length)throw Error(`featured schedule covered ${covered.size}/${pool.length}; increase --count before publishing its index`);
 // Preserve the previous index as well as every old match document.
 const indexPath=path.join(OUTPUT,'index.json');
 try{const previous=await fs.readFile(indexPath);const hash=crypto.createHash('sha256').update(previous).digest('hex').slice(0,16);
  const archive=path.join(OUTPUT,`archive-index-${hash}.json`);try{await fs.writeFile(archive,previous,{flag:'wx'})}catch(e){if(e.code!=='EEXIST')throw e}}
 catch(error){if(error.code!=='ENOENT')throw error}
 const indexDoc={schema:'m3t4.static-match-index.v1',generatedAt:T0,scheduleStartedAt:T0,totalScheduleMs:cursor-T0,matchCount:summaries.length,
  poolSize:pool.length,systemCount:pool.filter(f=>!f.isHuman).length,humanCount:pool.filter(f=>f.isHuman).length,
  coverage:{fighters:covered.size,total:pool.length},sim:{behaviorVersion:BEHAVIOR_VERSION,rulesVersion:RULES_VERSION},seed:SEED,matches:summaries};
 await fs.writeFile(indexPath,JSON.stringify(indexDoc));
 console.log(JSON.stringify({source:'local-roster-snapshot',matches:summaries.length,fighters:covered.size,stages:stages.length,
  behaviorVersion:BEHAVIOR_VERSION,rulesVersion:RULES_VERSION,totalScheduleMinutes:(cursor-T0)/60000,output:OUTPUT}));
})().catch(error=>{console.error(error.message);process.exitCode=1});
