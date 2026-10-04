import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Window} from 'happy-dom';
import {preparePageShell} from '../page-shell.mjs';

test('a cached page missing session controls boots with usable controls and current game links',async()=>{
  const window=new Window({settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true,disableJavaScriptEvaluation:true}});
  const document=window.document;
  document.write(readFileSync(new URL('../index.html',import.meta.url),'utf8'));
  for(const id of ['round-controls','watch-replay'])document.getElementById(id)?.remove();
  const footer=document.querySelector('.site-footer');
  footer.querySelector('a[href="/mandate-2038/"]').remove();
  footer.querySelector('a[href="/history"]').textContent='Play a meta fighter instead ↗';
  preparePageShell(document);
  const pause=document.getElementById('pause-round'),leave=document.getElementById('leave-round');
  assert.ok(pause&&leave);assert.equal(pause.type,'button');assert.equal(document.getElementById('round-controls').hidden,true);
  assert.equal(document.getElementById('watch-replay').disabled,true);
  let clicks=0;pause.onclick=()=>clicks++;
  preparePageShell(document);pause.click();
  assert.equal(clicks,1);assert.equal(document.querySelectorAll('#pause-round').length,1);
  assert.equal(document.querySelectorAll('#watch-replay').length,1);
  assert.equal(footer.querySelector('a[href="/history"]').textContent,'Play Meta Duel instead ↗');
  assert.equal(footer.querySelectorAll('a[href="/mandate-2038/"]').length,1);
  await window.happyDOM.close();
});

test('hosting revalidates extensionless HTML as well as scripts, while keeping asset caching',()=>{
  const {hosting}=JSON.parse(readFileSync(new URL('../../../firebase.json',import.meta.url),'utf8'));
  const fallback=hosting.headers.find(rule=>rule.source==='**');
  assert.match(fallback.headers.find(h=>h.key==='Cache-Control').value,/no-cache/);
  assert.ok(hosting.headers.some(rule=>rule.source.startsWith('/assets/')&&rule.headers.some(h=>h.value.includes('max-age=3600'))));
});
