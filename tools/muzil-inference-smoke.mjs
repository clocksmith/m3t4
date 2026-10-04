import { chromium } from 'playwright';
import { createDevServer } from './dev-serve.mjs';
import {writeFile, mkdtemp} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const output = await mkdtemp(join(tmpdir(),'muzil-inference-'));
// Requires local Gemma weights in the sibling checkout; no fake inference fallback.
const server=createDevServer({modelRoot:fileURLToPath(new URL('../../doppler/models/local/',import.meta.url))});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']});
try {
 const a=await browser.newPage(),b=await browser.newPage();const requesterRequests=[];a.on('request',r=>requesterRequests.push(r.url()));
 for(const p of [a,b]){await p.goto(origin + '/muzil/');p.on('pageerror',e=>console.log('pageerror',e.message));}
 await b.evaluate(async()=>{
  const {LocalController}=await import('/muzil/controller.mjs');const {PeerController}=await import('/muzil/peer.mjs');
  const source={manifest:await(await fetch('/__models/create-gemma-3-1b-qualification/manifest.json')).json(),baseUrl:location.origin+'/__models/gemma-3-1b-it-q4k-ehf16-af32'};
  window.executor=new LocalController({source});await executor.prepare();window.realPeer=new PeerController({local:executor});realPeer.sharing=true;await realPeer.connect(true);
 });
 const offer=await b.evaluate(()=>realPeer.exportCode());
 await a.evaluate(async()=>{const {PeerController}=await import('/muzil/peer.mjs');window.realPeer=new PeerController({local:{model:'none',session:null}});await realPeer.connect(false);});
 await a.evaluate(c=>realPeer.acceptCode(c),offer);const answer=await a.evaluate(()=>realPeer.exportCode());await b.evaluate(c=>realPeer.acceptCode(c),answer);
 await a.waitForFunction(()=>realPeer.ready);
 const result=await a.evaluate(async()=>{
  const {createPhone,observe,applyAction,makeReplay}=await import('/muzil/engine.mjs');const {parseDecision}=await import('/muzil/controller.mjs');
  let state=createPhone({roundId:'real-peer'});const memory=[observe(state)], steps=[];state=applyAction(state,{roundId:state.roundId,id:'start',type:'tap',target:'start'}).state;
  for(let i=0;i<10&&state.phase==='playing';i++){
   const observation=observe(state);const result=await realPeer.generate({kind:'action',observation,memory,profile:{objective:'finish',examples:[]}});
   steps.push({screen:state.screen,text:result.text,execution:result.execution});
   try{const action=parseDecision(result.text,observation);const applied=applyAction(state,{...action,id:'step'+i,roundId:state.roundId,screen:observation.screen});if(!applied.accepted)throw new Error(applied.reason);state=applied.state;memory.push(observe(state));}catch(e){steps.at(-1).error=e.message;break;}
  }
  const reply=await realPeer.generate({kind:'reply',message:'When should I pick you up?',context:'My appointment finishes at 5:40 PM.'});
  return{phase:state.phase,steps,reply,record:makeReplay(state)};
 });
 const report={scope:'Actual local Chrome WebGPU inference over Reploid WebRTC between two tabs on one Mac. Complete-model executor; no distributed partitions.',requesterWeightRequests:requesterRequests.filter(u=>u.includes('/__models/')||u.endsWith('.bin')),result};
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));console.log('Evidence: '+output);
 if(process.argv.includes('--require-completion') && result.phase !== 'finished') process.exitCode=1;
 console.log(JSON.stringify({phase:result.phase,steps:result.steps,reply:result.reply,requesterWeightRequests:report.requesterWeightRequests}));
} catch(e){console.log('FAILED',e.stack);process.exitCode=1;}finally{await browser.close();await new Promise(r=>server.close(r));}
