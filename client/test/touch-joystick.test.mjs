import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { joystickVector, bindTouchJoystick } from '../ui/touch-joystick.js';
import { arenaPresentation } from '../ui/arena-shell.js';

test('touch layout stays immersive after rotating into tall landscape viewports', () => {
  for (const [w,h,rotated] of [[390,844,true],[844,390,false],[1024,600,false],[600,1024,true]]) {
    assert.deepEqual(arenaPresentation(w,h,true),{immersive:true,rotated});
  }
  assert.deepEqual(arenaPresentation(1440,900,false),{immersive:false,rotated:false});
});

test('joystick maps drag into game axes and clamps diagonals in either orientation', () => {
  const rect={left:10,top:20,width:100,height:100};
  assert.deepEqual(joystickVector(rect,60,70),{x:0,y:0});
  assert.deepEqual(joystickVector(rect,110,70),{x:1,y:0});
  assert.deepEqual(joystickVector(rect,60,120,true),{x:1,y:-0});
  assert.deepEqual(joystickVector(rect,110,70,true),{x:0,y:-1});
  assert.ok(Math.abs(Math.hypot(...Object.values(joystickVector(rect,160,170)))-1)<1e-9);
});

test('drag owns one pointer, releases on cancellation and tears down listeners', async () => {
  const window=new Window(),doc=window.document;
  doc.body.innerHTML='<div id="stick"><span class="duel-joystick-thumb"></span></div>';
  const stick=doc.querySelector('#stick'),changes=[];
  stick.getBoundingClientRect=()=>({left:0,top:0,width:100,height:100});
  const binding=bindTouchJoystick(stick, input=>changes.push(input));
  const dispatch=(type,id,x,y)=>stick.dispatchEvent(new window.PointerEvent(type,{pointerId:id,clientX:x,clientY:y,cancelable:true}));
  dispatch('pointerdown',1,90,50);assert.equal(changes.at(-1).right,true);
  dispatch('pointerdown',2,10,50);assert.equal(changes.at(-1).right,true);
  dispatch('pointermove',1,50,10);assert.equal(changes.at(-1).up,true);
  dispatch('pointercancel',1,50,10);assert.ok(Object.values(changes.at(-1)).every(v=>!v));
  binding.destroy();const count=changes.length;dispatch('pointerdown',1,90,50);assert.equal(changes.length,count);
  await window.happyDOM.abort();
});
