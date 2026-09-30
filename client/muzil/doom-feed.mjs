import { doomPost } from './doom-content.mjs';
import { DoomShader } from './doom-shader.mjs';
const esc = text => String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const count = n => n >= 1000 ? `${(n/1000).toFixed(1)}k` : String(n);
export class DoomFeed {
  constructor(root, state, onSelect) {
    this.root = root; this.roundId = state.roundId; this.index = state.feedIndex; this.onSelect = onSelect; this.alive = true;
    root.innerHTML = `<section class="doom-app"><canvas class="doom-canvas" aria-hidden="true"></canvas><header class="doom-header"><strong>doom scroll<span>↯</span></strong><span>for you. forever.</span></header><div class="doom-scroller" tabindex="0" role="region" aria-label="Doom Scroll posts. Scroll or use arrow keys."></div><footer class="doom-controls"><button data-action="previous-post" aria-label="Previous post">↑</button><span class="doom-depth"></span><button data-action="like-post" aria-label="Like post" aria-pressed="false">♡</button><button data-action="next-post" aria-label="Next post">↓</button></footer></section>`;
    this.scroller = root.querySelector('.doom-scroller'); this.app = root.querySelector('.doom-app');
    this.shader = new DoomShader(root.querySelector('canvas'));
    this.onScroll = () => {
      const progress = this.start + this.scroller.scrollTop / Math.max(1,this.scroller.clientHeight);
      const now = performance.now(), speed = Math.max(-1,Math.min(1,(progress-(this.lastProgress ?? progress))*300/Math.max(16,now-(this.lastTime||now))));
      this.lastProgress = progress; this.lastTime = now;
      this.shader.update({scroll:progress,velocity:speed});
      this.app.style.setProperty('--drift',`${(progress-this.index)*16}deg`);
      clearTimeout(this.settle); this.settle = setTimeout(()=>this.settleScroll(),130);
    };
    this.scroller.addEventListener('scroll',this.onScroll,{passive:true});
    this.onKey = event => {
      if (['ArrowDown','PageDown','ArrowUp','PageUp',' '].includes(event.key)) {
        event.preventDefault();
        const direction = ['ArrowUp','PageUp'].includes(event.key) ? -1 : 1;
        const next = this.onSelect(Math.max(0,this.index+direction));
        if (this.alive) this.update(next,true);
      }
    };
    this.scroller.addEventListener('keydown',this.onKey);
    this.height = this.scroller.clientHeight;
    this.resize = new ResizeObserver(()=>{ if (this.alive && this.height !== this.scroller.clientHeight) { this.height = this.scroller.clientHeight; this.align(); } }); this.resize.observe(this.scroller);
    this.update(state,true);
  }
  settleScroll() {
    if (!this.alive) return;
    const target = Math.max(this.start,Math.min(this.end, this.start + Math.round(this.scroller.scrollTop/Math.max(1,this.scroller.clientHeight))));
    if (target === this.index) return;
    const state = this.onSelect(target);
    if (this.alive) this.update(state,true);
  }
  align() { this.scroller.scrollTop = (this.index-this.start)*this.scroller.clientHeight; }
  update(state, force = false) {
    const changed = this.index !== state.feedIndex;
    this.index = state.feedIndex;
    if (changed || force) {
      this.start = Math.max(0,this.index-2); this.end = this.index+2;
      this.scroller.innerHTML = Array.from({length:this.end-this.start+1},(_,i)=>this.card(this.start+i,state)).join('');
      this.align();
    }
    const post = doomPost(this.roundId,this.index), liked = state.feedLikes.includes(this.index);
    this.app.style.setProperty('--doom-hue',String(post.hue));
    this.app.dataset.index = String(this.index);
    this.root.querySelector('.doom-depth').textContent = `↓ ${String(this.index+1).padStart(3,'0')} · ${post.label}`;
    const like = this.root.querySelector('[data-action="like-post"]'); like.textContent = liked?'♥':'♡'; like.setAttribute('aria-pressed',String(liked)); like.setAttribute('aria-label',liked?'Unlike post':'Like post');
    this.root.querySelector('[data-action="previous-post"]').disabled = this.index===0;
    this.root.querySelector(`[data-post="${this.index}"] .doom-likes`)?.replaceChildren(`${count(post.likes+(liked?1:0))} likes`);
    this.shader.update({scroll:this.index,nonsense:post.nonsense/100,hue:post.hue/360,pulse:liked?1:0});
    this.setActive(state.phase==='playing');
  }
  card(index, state) {
    const p = doomPost(this.roundId,index);
    return `<article class="doom-post" data-post="${index}" aria-label="Post ${index+1}"><div class="doom-author"><span class="doom-avatar">${p.symbol}</span><div><strong>@${p.handle}</strong><small>Sponsored by your attention</small></div><span>•••</span></div><div class="doom-art" aria-hidden="true"><span class="doom-orbit"></span><span class="doom-symbol">${p.symbol}</span><span class="doom-art-caption">${p.topic}</span></div><div class="doom-post-copy"><div class="doom-classifier"><span title="Language guess from local word matches">${p.language.toUpperCase()}</span><span>NONSENSE ${p.nonsense}/100</span><i style="--score:${p.nonsense}%"></i></div><p lang="${p.sourceLanguage}">${esc(p.text)}</p><div class="doom-social"><span class="doom-likes">${count(p.likes+(state.feedLikes.includes(index)?1:0))} likes</span><span>${count(Math.floor(p.likes/21))} opinions</span></div></div></article>`;
  }
  setActive(active) { this.shader.setActive(active); this.scroller.style.overflowY = active?'auto':'hidden'; }
  destroy() { this.alive=false; clearTimeout(this.settle); this.resize.disconnect(); this.shader.destroy(); this.scroller.removeEventListener('scroll',this.onScroll); this.scroller.removeEventListener('keydown',this.onKey); }
}
