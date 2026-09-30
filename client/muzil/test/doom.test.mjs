import test from 'node:test';
import assert from 'node:assert/strict';
import { doomPost, classifyPost } from '../doom-content.mjs';
import { createPhone, applyAction, observe, makeReplay, replay } from '../engine.mjs';
test('generated feed is varied, seeded and independent of ambient randomness',()=>{
 const posts=Array.from({length:100},(_,i)=>doomPost('round',i));
 assert.deepEqual(posts,Array.from({length:100},(_,i)=>doomPost('round',i)));
 assert.equal(new Set(posts.map(p=>p.sourceLanguage)).size,4);assert.ok(new Set(posts.map(p=>p.text)).size>75);
 assert.notDeepEqual(doomPost('other',0),posts[0]);
 for(const p of posts) assert.ok(p.nonsense>=0&&p.nonsense<=99);
});
test('language guessing and nonsense scoring use separate evidence',()=>{
 for(const [text,language] of [['the book is on your desk','en'],['el libro es para mi','es'],['le livre est pour vous','fr'],['o livro e seu mas nao meu','pt']]) {
  assert.equal(classifyPost(text).language,language);assert.ok(classifyPost(text).nonsense<10);
 }
 assert.equal(classifyPost('zxqv blorp 123').language,'und');
 assert.ok(classifyPost('The quantum toaster has a secret cosmic soup podcast. UNBELIEVABLE!').nonsense>70);
});
test('human scroll and model post commands share state, likes and replay',()=>{
 let s=createPhone({roundId:'doom'}),n=0;
 const act=target=>{const result=applyAction(s,{roundId:s.roundId,id:`d${n++}`,type:'tap',target});assert.equal(result.accepted,true);s=result.state;};
 act('start');act('app:feed');assert.equal(observe(s).actions.some(a=>a.target==='previous-post'),false);
 act('next-post');act('like-post');act('next-post');act('previous-post');
 assert.equal(s.feedIndex,1);assert.deepEqual(s.feedLikes,[1]);assert.ok(observe(s).text.some(t=>t.includes(doomPost('doom',1).text)));
 assert.deepEqual(replay(makeReplay(s)),s);act('home');act('app:feed');assert.equal(s.feedIndex,1);act('like-post');assert.deepEqual(s.feedLikes,[]);
});
