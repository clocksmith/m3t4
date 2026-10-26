// The arena's short lore page; gameplay instructions remain at /rules.
import { escapeHtml } from '../ui/html.js';
import { pageHeaderHtml } from '../ui/shell.js';

const paragraphs = [
  'In 2038, humanity failed to raise capital. The world didn’t burn; it compiled. The growth engines kept running after their operators disappeared. Electricity still reaches the racks. The debt clock still runs.',
  'The machine preserves the last executive class as rival combat policies. They fight through datacenters, boardrooms, and demo days. Kills create proof. Carry it to a live demand node and deliver it before someone takes it from you.',
  'You are the tuner. Pilot a fighter yourself or shape a policy and watch it compete. The machine calls that survival. You call it service.',
];

export function mount(root, { setStatus }) {
  setStatus('about');
  root.innerHTML = `<div class="page rules-page about-page">
    ${pageHeaderHtml({ title: 'About' })}
    <section class="rules-about-copy" aria-label="Meta Duel lore">
      ${paragraphs.map(text => `<p>${escapeHtml(text)}</p>`).join('')}
    </section>
  </div>`;
}

export function unmount() {}
