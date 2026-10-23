import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { watchPageHtml, fallbackCosmeticsForCompetitor } from '../modes/spectate.js';
import { buildPageHtml } from '../modes/build.js';
import { mountArenaShell } from '../ui/arena-shell.js';

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

test('Watch gives the arena the shared shell and preserves controls in its closed dialog', () => {
  const doc=documentFor(watchPageHtml());
  const shell=mountArenaShell(doc.body,{title:'Watch',canvas:doc.querySelector('#stage-canvas'),frame:doc.querySelector('#spectate-stage')});
  assert.equal(doc.querySelector('h1').textContent,'Watch');
  assert.match(doc.querySelector('.page-subtitle').textContent,/recorded fights.*archive/i);
  assert.equal(doc.querySelector('#stage-canvas').closest('dialog'),null);
  assert.equal(doc.querySelector('dialog').open,false);
  assert.equal(doc.querySelector('#stage-canvas').closest('details'),null);
  assert.equal(doc.querySelector('#spectate-audio').closest('dialog').id,'arena-dialog');
  for(const id of ['stat-p1','stat-p2','stat-stage','stat-countdown','stat-buf','stat-verify','spectate-dash-cycle','leaderboard','leaderboard-more','live-bots-list','live-bots-more','stream-log','live-bot-events']) {
    const el=doc.getElementById(id);
    assert.ok(el,`${id} remains available`);
    assert.equal(el.closest('details').open,false,`${id} is progressively disclosed`);
  }
  const ids=[...doc.querySelectorAll('[id]')].map(el=>el.id);
  assert.equal(new Set(ids).size,ids.length);
  shell.destroy(); doc.defaultView.happyDOM.abort();
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

test('Tune renders character and weapon picker for both player slots', () => {
  const doc = documentFor(buildPageHtml());
  const folds = doc.querySelectorAll('.player-cosmetics-fold');
  assert.equal(folds.length, 2, 'both player slots have cosmetics fold');
  for (const slot of [0, 1]) {
    const slotBodyButtons = doc.querySelectorAll(`.duel-body-option[data-slot="${slot}"]`);
    assert.equal(slotBodyButtons.length, 6, `slot ${slot} offers all 6 roster bodies`);
    const slotWeaponButtons = doc.querySelectorAll(`.duel-weapon-option[data-slot="${slot}"]`);
    assert.ok(slotWeaponButtons.length > 0, `slot ${slot} offers weapons for initial body`);
  }
});

test('Watch fallback cosmetics rotate across parody roster bodies for bots', () => {
  const bots = [
    { handle: 'sys_founder' },
    { handle: 'sys_regulatory' },
    { handle: 'sys_oracle' },
    { handle: 'sys_operator' },
    { handle: 'sys_incumbent' },
    { handle: 'sys_unicorn' },
  ];
  const assigned = bots.map((b, i) => fallbackCosmeticsForCompetitor(b, i % 2).body);
  assert.deepEqual(assigned, ['sama', 'darrius', 'demis', 'mark', 'jensen', 'elon']);
});
