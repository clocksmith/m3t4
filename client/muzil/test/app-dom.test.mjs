import {Window} from 'happy-dom';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const base=fileURLToPath(new URL('../',import.meta.url));
const modules=['task-templates','round-report','match','mini-app-view','mini-apps','distraction-view','scenarios','challenges','engine','decision','notification-policy','notification-gestures','phone-render'];
const imports=Object.assign({},...await Promise.all(modules.map(m=>import(`${base}${m}.mjs`))));
test('phone UI preserves composition and selection, defers the round clock, and keeps real exits available',async()=>{
const window=new Window({url:'http://localhost/muzil/',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}});
window.document.write(readFileSync(`${base}index.html`,'utf8'));
Object.defineProperty(window.document,'fonts',{value:{ready:Promise.resolve()}});
let now=1000,timer=0;const intervals=[],timers=new Map();
class Controller{ready=false;state='offline';status='Not connected';cancel(){}close(){}sendGame(){} }
const noop=()=>{};
Object.assign(globalThis,{document:window.document,requestAnimationFrame:()=>0,cancelAnimationFrame:noop});
const context=vm.createContext({...imports,window,document:window.document,navigator:window.navigator,localStorage:window.localStorage,crypto:webcrypto,structuredClone,console,
 performance:{now:()=>now},setTimeout:(f,ms)=>{timers.set(++timer,{f,ms});return timer;},clearTimeout:id=>timers.delete(id),setInterval:f=>{intervals.push(f);return intervals.length;},clearInterval:noop,
 requestAnimationFrame:()=>0,cancelAnimationFrame:noop,ResizeObserver:class{observe(){}},getComputedStyle:window.getComputedStyle.bind(window),matchMedia:()=>({matches:true}),
 AbortController,AbortSignal,LocalController:Controller,MeshController:Controller,PeerController:Controller,DoomFeed:class{},
 bindToasterEntry:()=>({cancel(){},start(){}}),
 loadChallenges:async()=>imports.parseCatalog(JSON.parse(readFileSync(`${base}challenges.json`)))
});
// Module dependencies run normally; app imports are supplied to the DOM harness.
const source=readFileSync(`${base}app.mjs`,'utf8').replace(/^import .*;\n/gm,'').replace(/export const /g,'const ');
await vm.runInContext(`(async()=>{${source}\n globalThis.testApp={get state(){return state},get preparing(){return preparing},get paused(){return pausedAt},newRound,dispatch,render,flushEdit,beginPreparedRound};})()`,context);
const app=context.testApp,$=id=>window.document.getElementById(id);
$('challenge-select').value='changing-coordinate';app.newRound();assert.equal(app.state.phase,'ready');assert.equal(app.preparing,true);assert.equal($('task-note-content').dataset.visible,'true');
now+=5000;intervals[0]();assert.equal(app.state.elapsed,0);$('dismiss-reveal').click();assert.equal(app.state.phase,'playing');assert.equal(app.preparing,false);
app.dispatch({type:'tap',target:'app:messages'});app.dispatch({type:'tap',target:'contact:driver'});
const field=$('phone-reply');field.focus();field.value='Meet me at the gar';field.setSelectionRange(18,18);field.dispatchEvent(new window.InputEvent('input',{bubbles:true,inputType:'insertText',data:'r'}));
app.flushEdit();app.render();assert.strictEqual($('phone-reply'),field);assert.equal(field.selectionStart,18);
field.dispatchEvent(new window.CompositionEvent('compositionstart',{bubbles:true}));
field.value+='den — 钥匙';field.dispatchEvent(new window.InputEvent('input',{bubbles:true,isComposing:true}));
now+=7000;intervals[0]();assert.equal(app.state.notifications.length,0);app.render();assert.strictEqual($('phone-reply'),field);
field.dispatchEvent(new window.CompositionEvent('compositionend',{bubbles:true,data:'钥匙'}));intervals[0]();assert.equal(app.state.drafts.driver,field.value);assert.ok(app.state.notifications.length);
assert.strictEqual($('phone-reply'),field);assert.equal($('phone-screen').inert,true);
$('pause-round').click();const elapsed=app.state.elapsed;now+=20000;intervals[0]();assert.equal(app.state.elapsed,elapsed);assert.ok(app.paused!==null);$('pause-round').click();intervals[0]();assert.equal(app.state.elapsed,elapsed);
const alert=app.state.notifications[0];app.dispatch({type:'tap',target:`notification:${alert.id}`});app.dispatch({type:'tap',target:'bait:leave'});
assert.equal(app.state.drafts.driver,'Meet me at the garden — 钥匙');
const f=$('phone-reply');assert.ok(f);
f.value='  Exact spaces, punctuation!\nDictation, paste — yes.  ';f.dispatchEvent(new window.InputEvent('input',{bubbles:true,inputType:'insertFromPaste'}));app.flushEdit();
app.dispatch({type:'tap',target:'send'});assert.equal(app.state.sent.at(-1).text,f.value||'  Exact spaces, punctuation!\nDictation, paste — yes.  ');assert.strictEqual($('phone-reply'),f);
assert.equal($('agent-round').textContent,'Connect a stand-in');assert.equal($('watch-agent').disabled,true);
$('leave-round').click();assert.equal(app.state.phase,'ready');assert.equal($('intro').hidden,false);assert.equal($('game-stage').hidden,true);

$('challenge-select').value='early-shift';app.newRound();app.beginPreparedRound();
app.dispatch({type:'tap',target:'app:clock'});app.dispatch({type:'type',target:'alarm',value:'06:00'});app.dispatch({type:'tap',target:'save-alarm'});
assert.equal(app.state.phase,'finished');assert.equal($('watch-replay').disabled,false);
$('watch-replay').click();assert.equal($('round-status').textContent,'Recorded replay. No new inference.');
assert.equal(app.state.phase,'finished');
$('leave-round').click();
// A paused intention reveal cannot start the round through its outside control.
app.newRound();$('pause-round').click();app.beginPreparedRound();assert.equal(app.state.phase,'ready');
$('pause-round').click();app.beginPreparedRound();assert.equal(app.state.phase,'playing');
await window.happyDOM.close();

});
