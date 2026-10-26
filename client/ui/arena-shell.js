// One presentation shell for Watch, Tune and Play. Reparent existing controls,
// never recreate a canvas, renderer, editor or match when settings are toggled.
import { getAudio } from '../lib/audio.js';
export function fitArenaRect(width, height) {
  const w = Math.max(0, Math.min(Number(width) || 0, (Number(height) || 0) * 16 / 9));
  return { width: w, height: w * 9 / 16 };
}

export function bindArenaDialog(dialog, opener, { onOpen = () => {}, onClose = () => {} } = {}) {
  let previousFocus = null;
  let active = false;
  const close = () => { if (dialog.open) dialog.close(); };
  const opened = () => {
    if (active) return;
    previousFocus = dialog.ownerDocument.activeElement;
    // Native showModal can reject disconnected/already non-modal elements.
    // Do not pause the owner or mark this binding active until it succeeds.
    dialog.showModal();
    active = true;
    onOpen();
    opener.setAttribute('aria-expanded', 'true');
    dialog.querySelector('[data-dialog-close]')?.focus();
  };
  const closed = () => {
    if (!active) return;
    active = false;
    opener.setAttribute('aria-expanded', 'false');
    onClose();
    if (previousFocus?.isConnected) previousFocus.focus();
    else if (opener.isConnected) opener.focus();
  };
  const cancel = event => { event.preventDefault(); close(); };
  const click = event => { if (event.target.closest?.('[data-dialog-close]')) close(); };
  opener.addEventListener('click', opened);
  dialog.addEventListener('cancel', cancel);
  dialog.addEventListener('close', closed);
  dialog.addEventListener('click', click);
  return { open: opened, close, get isOpen() { return active; }, destroy() {
    opener.removeEventListener('click', opened);
    dialog.removeEventListener('cancel', cancel);
    dialog.removeEventListener('close', closed);
    dialog.removeEventListener('click', click);
    if (dialog.open) dialog.close();
    active = false;
  } };
}

export function mountArenaShell(root, { title, canvas, frame = null, actions = [], pause = null, status = null, note = '', onOpen, onClose }) {
  const doc = root.ownerDocument;
  const page = root.querySelector('.page');
  const subtitle = page.querySelector('.page-subtitle')?.textContent ?? '';
  const controls = [...page.children];
  const toolbar = doc.createElement('div');
  toolbar.className = 'arena-toolbar';
  const heading = doc.createElement('div');
  heading.className = 'arena-heading';
  const h1 = doc.createElement('h1'); h1.textContent = title;
  const hint = doc.createElement('div'); hint.className = 'page-subtitle tight'; hint.textContent = subtitle;
  if (status) { status.classList.add('page-subtitle'); heading.append(h1, status); }
  else heading.append(h1, hint);
  toolbar.append(heading);
  const buttons = doc.createElement('div'); buttons.className = 'arena-actions';
  for (const action of actions) if (action) buttons.append(action);
  if (pause) buttons.append(pause);
  const opener = doc.createElement('button');
  opener.type = 'button'; opener.id = 'arena-settings'; opener.textContent = title === 'Tune' ? 'Tune fighters' : 'Settings';
  opener.setAttribute('aria-haspopup', 'dialog'); opener.setAttribute('aria-controls', 'arena-dialog'); opener.setAttribute('aria-expanded', 'false');
  buttons.append(opener); toolbar.append(buttons);
  const viewport = doc.createElement('div'); viewport.className = 'arena-viewport';
  frame ??= doc.createElement('div'); frame.classList.add('arena-frame');
  if (!frame.contains(canvas)) frame.append(canvas);
  const touch = page.querySelector('#duel-touch-controls');
  if (touch) frame.append(touch);
  page.querySelector('#duel-touch-setup')?.remove();
  const audioPrompt = doc.createElement('button');
  audioPrompt.type = 'button';
  audioPrompt.id = 'arena-audio-prompt';
  audioPrompt.className = 'arena-audio-prompt';
  const toggleAudio = () => {
    const audio = getAudio();
    // A suspended browser context needs an unlock gesture before it can play.
    audio.setEnabled(!audio.isEnabled() || !audio.isUnlocked);
    updateAudioButton();
  };
  audioPrompt.addEventListener('click', toggleAudio);
  toolbar.insertBefore(audioPrompt, buttons);
  viewport.append(frame);
  const dialog = doc.createElement('dialog');
  dialog.id = 'arena-dialog'; dialog.className = 'arena-dialog'; dialog.setAttribute('aria-labelledby', 'arena-dialog-title');
  const header = doc.createElement('div'); header.className = 'arena-dialog-header';
  const label = doc.createElement('h2'); label.id = 'arena-dialog-title'; label.textContent = title === 'Tune' ? 'Tune fighters' : `${title} settings`;
  const close = doc.createElement('button'); close.type = 'button'; close.dataset.dialogClose = ''; close.textContent = 'Done';
  header.append(label, close); dialog.append(header);
  const navigation = doc.createElement('nav');
  navigation.className = 'arena-navigation';
  navigation.setAttribute('aria-label', 'Game navigation');
  for (const [name, href] of [['Watch', '/watch'], ['Tune', '/tune'], ['Play', '/duel'], ['Home', '/']]) {
    const link = doc.createElement('a'); link.textContent = name; link.href = href;
    if (name === title) link.setAttribute('aria-current', 'page');
    navigation.append(link);
  }
  dialog.append(navigation);
  if (note) { const p = doc.createElement('p'); p.className = 'arena-dialog-note'; p.textContent = note; dialog.append(p); }
  const content = doc.createElement('div'); content.className = 'arena-dialog-content';
  for (const node of controls) {
    if (node.classList.contains('page-header-row')) continue;
    content.append(node);
  }
  // The old containers may now be empty; retaining the rest preserves listeners,
  // live statistics, editor state and compute-dashboard node ownership.
  dialog.append(content);
  page.replaceChildren(toolbar, viewport, dialog);
  page.classList.add('arena-page'); doc.body.classList.add('arena-mounted');
  const modal = bindArenaDialog(dialog, opener, { onOpen, onClose });
  let raf = 0;
  const win = doc.defaultView;
  const updateAudioButton = () => {
    try {
      const audio = getAudio();
      const playing = audio.isUnlocked;
      audioPrompt.textContent = playing ? 'Sound on' : 'Sound off';
      audioPrompt.setAttribute('aria-pressed', String(playing));
      audioPrompt.setAttribute('aria-label', playing ? 'Mute sound' : 'Turn on sound');
      for (const toggle of dialog.querySelectorAll('input[id$="-audio"]')) toggle.checked = audio.isEnabled();
    } catch {
      audioPrompt.textContent = 'Sound off';
      audioPrompt.setAttribute('aria-label', 'Turn on sound');
    }
  };
  let audioTimer = 0;
  const audioGesture = () => {
    win.clearTimeout(audioTimer);
    audioTimer = win.setTimeout(updateAudioButton, 150);
  };
  win.addEventListener('pointerdown', audioGesture, { capture: true, passive: true });
  win.addEventListener('keydown', audioGesture, { capture: true });
  win.addEventListener('m3t4:audiochange', updateAudioButton);
  updateAudioButton();
  const resize = () => {
    raf = 0;
    // Use the layout viewport shared by all routes, not the transient visual
    // viewport height while initial canvas overflow or a modal keyboard settles.
    const isMobilePortrait = Boolean(win?.matchMedia?.('(max-width: 768px) and (orientation: portrait)').matches);
    const isMobileLandscape = Boolean(win?.matchMedia?.('(max-height: 500px) and (orientation: landscape)').matches);
    page.dataset.arenaRotation = isMobilePortrait ? '90' : '0';
    let availW, availH;
    if (isMobilePortrait || isMobileLandscape) {
      // Layout dimensions remain unrotated; CSS rotates the whole game and HUD.
      availW = viewport.clientWidth;
      availH = viewport.clientHeight;
    } else {
      const top = viewport.getBoundingClientRect().top;
      const nav = doc.querySelector('#topnav nav');
      const navHeight = nav && win.getComputedStyle(nav).position === 'fixed' ? nav.getBoundingClientRect().height : 0;
      availW = viewport.clientWidth;
      availH = Math.max(0, win.innerHeight - top - navHeight - 8);
    }
    const size = fitArenaRect(availW, availH);
    frame.style.width = `${size.width}px`; frame.style.height = `${size.height}px`;
  };
  const schedule = () => { if (!raf) raf = win.requestAnimationFrame(resize); };
  const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
  observer?.observe(viewport); if (doc.querySelector('#topnav')) observer?.observe(doc.querySelector('#topnav'));
  win.addEventListener('resize', schedule); win.visualViewport?.addEventListener('resize', schedule);
  doc.addEventListener('fullscreenchange', schedule); resize();
  return { open: modal.open, close: modal.close, get isOpen() { return modal.isOpen; }, dialog, resize, destroy() {
    modal.destroy(); observer?.disconnect(); if (raf) win.cancelAnimationFrame(raf);
    win.removeEventListener('resize', schedule); win.visualViewport?.removeEventListener('resize', schedule);
    win.removeEventListener('pointerdown', audioGesture, true);
    win.removeEventListener('keydown', audioGesture, true);
    win.removeEventListener('m3t4:audiochange', updateAudioButton);
    win.clearTimeout(audioTimer);
    audioPrompt.removeEventListener('click', toggleAudio);
    doc.removeEventListener('fullscreenchange', schedule); doc.body.classList.remove('arena-mounted');
  } };
}
