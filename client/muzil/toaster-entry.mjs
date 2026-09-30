// The lever and the text button share one entry sequence. The round starts only
// after the preview phone has popped, so the introduction costs no game time.
export function bindToasterEntry(start) {
  const scene = document.querySelector('.toaster-scene');
  const phone = document.getElementById('peek-phone');
  const lever = document.getElementById('toaster-lever');
  const button = document.getElementById('start-round');
  const knob = lever.querySelector('i');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let busy = false, generation = 0, animations = [];
  function cancel() {
    generation++;
    animations.forEach(a => a.cancel()); animations = [];
    busy = false; button.disabled = lever.disabled = false;
    scene.classList.remove('toasting');
    scene.removeAttribute('aria-busy');
  }
  async function play() {
    if (busy) return;
    busy = true; const current = ++generation;
    button.disabled = lever.disabled = true;
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
        await Promise.all([
          animate(phone, [
            { transform:'translateY(20px) rotate(-4deg)', offset:0 },
            { transform:'translateY(20px) rotate(-4deg)', offset:.2 },
            { transform:'translateY(-102px) rotate(3deg)', offset:.8 },
            { transform:'translateY(-94px) rotate(0)', offset:1 },
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
