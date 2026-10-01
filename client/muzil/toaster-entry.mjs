// The lever and the text button share one entry sequence. The round starts only
// after the preview phone has popped, so the introduction costs no game time.
export function bindToasterEntry(start) {
  const scene = document.querySelector('.toaster-scene');
  const phone = document.getElementById('peek-phone');
  const lever = document.getElementById('toaster-lever');
  const button = document.getElementById('start-round');
  const knob = lever.querySelector('i');
  const dial = document.getElementById('toaster-dial');
  const setting = document.getElementById('toast-setting');
  const levels = ['Barely warm', 'Lightly toasted', 'Golden', 'Crunchy', 'Extra crispy'];
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let busy = false, generation = 0, animations = [];
  let drag = null;
  function updateDial() {
    const level = Number(dial.value);
    scene.style.setProperty('--dial-angle', `${(level - 3) * 55}deg`);
    scene.style.setProperty('--toast-heat', String((level - 1) / 4));
    scene.dataset.toastLevel = String(level);
    dial.setAttribute('aria-valuetext', `${level} — ${levels[level - 1]}`);
    setting.textContent = `${level} · ${levels[level - 1]}`;
  }
  const setDial = value => { dial.value = String(Math.max(1, Math.min(5, value))); updateDial(); };
  dial.addEventListener('input', updateDial);
  // Mobile range controls otherwise apply their own horizontal jump after
  // pointerdown, competing with the rotary gesture. Keep native keyboard input.
  dial.addEventListener('touchstart', event => event.preventDefault(), { passive:false });
  dial.addEventListener('touchmove', event => event.preventDefault(), { passive:false });
  dial.addEventListener('pointerdown', event => {
    if (dial.disabled || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault(); dial.focus(); dial.setPointerCapture(event.pointerId);
    drag = { id:event.pointerId, x:event.clientX, y:event.clientY, level:Number(dial.value), moved:false };
  });
  dial.addEventListener('pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x, dy = drag.y - event.clientY;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    if (drag.moved) setDial(drag.level + Math.round((dx + dy) / 16));
  });
  dial.addEventListener('pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.moved) setDial(Number(dial.value) % 5 + 1);
    drag = null; dial.releasePointerCapture(event.pointerId);
  });
  dial.addEventListener('pointercancel', () => { drag = null; });
  dial.addEventListener('lostpointercapture', () => { drag = null; });
  dial.addEventListener('click', event => event.preventDefault());
  updateDial();
  function cancel() {
    generation++;
    animations.forEach(a => a.cancel()); animations = [];
    busy = false; button.disabled = lever.disabled = dial.disabled = false;
    scene.classList.remove('toasting');
    scene.removeAttribute('aria-busy');
  }
  async function play() {
    if (busy) return;
    busy = true; const current = ++generation;
    button.disabled = lever.disabled = dial.disabled = true;
    drag = null;
    const level = Number(dial.value), hold = 80 + (level - 1) * 160;
    const lift = 76 + level * 9;
    scene.classList.add('toasting'); scene.setAttribute('aria-busy', 'true');
    const animate = (el, frames, options) => {
      const animation = el.animate(frames, { fill:'forwards', ...options });
      animations.push(animation); return animation.finished;
    };
    try {
      if (!motion.matches) {
        await Promise.all([
          animate(knob, [{ transform:'translateY(0)' }, { transform:'translateY(34px)' }], { duration:180, easing:'ease-in' }),
          animate(phone, [{ transform:'translateY(0) rotate(-4deg)' }, { transform:'translateY(20px) rotate(-4deg)' }], { duration:180, easing:'ease-in' }),
        ]);
        await animate(phone, [{ transform:'translateY(20px) rotate(-4deg)' }, { transform:'translateY(20px) rotate(-4deg)' }], { duration:hold });
        await Promise.all([
          animate(phone, [
            { transform:'translateY(20px) rotate(-4deg)', offset:0 },
            { transform:'translateY(20px) rotate(-4deg)', offset:.2 },
            { transform:`translateY(-${lift + 8}px) rotate(${level}deg)`, offset:.8 },
            { transform:`translateY(-${lift}px) rotate(0)`, offset:1 },
          ], { duration:480, easing:'cubic-bezier(.2,.7,.2,1)' }),
          animate(knob, [{ transform:'translateY(34px)' }, { transform:'translateY(0)' }], { delay:190, duration:200, easing:'ease-out' }),
        ]);
      }
      if (current !== generation) return;
      start(phone.getBoundingClientRect());
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    } finally { if (current === generation) cancel(); }
  }
  lever.onclick = button.onclick = play;
  motion.addEventListener('change', cancel);
  window.addEventListener('pagehide', cancel);
  return { play, cancel };
}
