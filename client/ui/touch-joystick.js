// Movement is measured in game axes, including the clockwise portrait rotation.
export function joystickVector(rect, clientX, clientY, rotated = false) {
  const sx = (clientX - rect.left - rect.width / 2) / (rect.width / 2);
  const sy = (clientY - rect.top - rect.height / 2) / (rect.height / 2);
  const x = rotated ? sy : sx, y = rotated ? -sx : sy;
  const length = Math.max(1, Math.hypot(x, y));
  return { x: x / length, y: y / length };
}

export function bindTouchJoystick(element, onChange) {
  let pointer = null;
  const thumb = element.querySelector('.duel-joystick-thumb');
  const reset = () => {
    const previous = pointer; pointer = null;
    try { if (previous !== null) element.releasePointerCapture(previous); } catch {}
    thumb.style.transform = 'translate(0, 0)';
    element.classList.remove('is-active');
    onChange({ left: false, right: false, up: false, down: false });
  };
  const move = event => {
    if (event.pointerId !== pointer) return;
    event.preventDefault();
    const rotated = !!element.closest('[data-arena-rotation="90"]');
    const vector = joystickVector(element.getBoundingClientRect(), event.clientX, event.clientY, rotated);
    const travel = element.clientWidth * .3;
    thumb.style.transform = `translate(${vector.x * travel}px, ${vector.y * travel}px)`;
    const deadzone = .28;
    onChange({ left: vector.x < -deadzone, right: vector.x > deadzone, up: vector.y < -.45, down: vector.y > .45 });
  };
  const down = event => {
    if (pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
    pointer = event.pointerId;
    try { element.setPointerCapture(pointer); } catch {}
    element.classList.add('is-active'); move(event);
  };
  const up = event => { if (event.pointerId === pointer) reset(); };
  element.addEventListener('pointerdown', down);
  element.addEventListener('pointermove', move);
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.addEventListener(type, up);
  return { reset, destroy() {
    reset(); element.removeEventListener('pointerdown', down); element.removeEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) element.removeEventListener(type, up);
  } };
}
