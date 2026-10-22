import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { watchPageHtml } from '../modes/spectate.js';

function documentFor(html) {
  const window = new Window();
  window.document.body.innerHTML = html;
  return window.document;
}

test('primary navigation offers Watch, Tune and Play with existing routes', () => {
  const doc=documentFor(readFileSync(new URL('../history/index.html',import.meta.url),'utf8'));
  const links=[...doc.querySelectorAll('#topnav [data-nav="primary"]')];
  assert.deepEqual(links.map(a=>a.textContent.trim()),['Watch','Tune','Play']);
  assert.deepEqual(links.map(a=>a.getAttribute('href')),['/live','/tune','/duel']);
  assert.ok(links[1].dataset.routeGroup.split(' ').includes('roster'));
  assert.equal(doc.querySelector('#account').dataset.state,'anon');
});

test('Watch shows the arena and audio first while preserving collapsed secondary controls', () => {
  const doc=documentFor(watchPageHtml());
  assert.equal(doc.querySelector('h1').textContent,'Watch');
  assert.match(doc.querySelector('.page-subtitle').textContent,/recorded fights.*archive/i);
  assert.equal(doc.querySelector('.spectate-grid').firstElementChild.className,'spectate-center');
  assert.equal(doc.querySelector('#stage-canvas').closest('details'),null);
  assert.equal(doc.querySelector('#spectate-audio').closest('details'),null);
  for(const id of ['stat-p1','stat-p2','stat-stage','stat-countdown','stat-buf','stat-verify','spectate-dash-cycle','leaderboard','leaderboard-more','live-bots-list','live-bots-more','stream-log','live-bot-events']) {
    const el=doc.getElementById(id);
    assert.ok(el,`${id} remains available`);
    assert.equal(el.closest('details').open,false,`${id} is progressively disclosed`);
  }
  const ids=[...doc.querySelectorAll('[id]')].map(el=>el.id);
  assert.equal(new Set(ids).size,ids.length);
});

test('Watch accurately distinguishes a live server feed from the archive', () => {
  const original=globalThis.window;
  try {
    globalThis.window={__M3T4_USE_FIREBASE_FEED__:true};
    const doc=documentFor(watchPageHtml());
    assert.match(doc.querySelector('.page-subtitle').textContent,/Live server matches/);
    assert.doesNotMatch(doc.querySelector('.page-subtitle').textContent,/archive/);
  } finally { if(original===undefined)delete globalThis.window;else globalThis.window=original; }
});
