import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { fitArenaRect, mountArenaShell, bindArenaDialog } from '../ui/arena-shell.js';

test('all viewport shapes keep the largest contained exact 16:9 arena', () => {
  for (const [width,height] of [[1440,740],[390,640],[844,220],[2560,900],[1,1],[0,0]]) {
    const rect=fitArenaRect(width,height);
    assert.ok(rect.width<=width+1e-9); assert.ok(rect.height<=height+1e-9);
    assert.equal(rect.height,rect.width*9/16);
    assert.ok(Math.abs(rect.width-width)<1e-9 || Math.abs(rect.height-height)<1e-9);
  }
});

test('each mode reparents the same canvas and controls into the identical shell without losing state', () => {
  for (const title of ['Watch','Tune','Play']) {
    const window=new Window(),doc=window.document;
    doc.body.innerHTML='<header id="topnav"><nav></nav></header><main><div class="page"><div class="page-header-row"><h1>old</h1><div class="page-subtitle">kept description</div></div><section><canvas></canvas><input value="saved edits"><button id="start">Start</button><span id="tick">119</span></section></div></main>';
    const canvas=doc.querySelector('canvas'),input=doc.querySelector('input'),start=doc.querySelector('#start');
    const shell=mountArenaShell(doc.querySelector('main'),{title,canvas,actions:[start]});
    assert.equal(doc.querySelector('.arena-frame canvas'),canvas);
    assert.equal(doc.querySelector('.arena-dialog input'),input);
    assert.equal(input.value,'saved edits'); assert.equal(doc.querySelector('#tick').textContent,'119');
    assert.equal(doc.querySelector('.arena-actions #start'),start);
    assert.deepEqual([...doc.querySelector('.arena-page').children].map(e=>e.className),['arena-toolbar','arena-viewport','arena-dialog']);
    assert.equal(shell.dialog.open,false);
    shell.destroy(); window.happyDOM.abort();
  }
});

test('settings close/escape restore focus exactly once, preserve values and remove lifecycle listeners', async () => {
  const window=new Window(),doc=window.document;
  doc.body.innerHTML='<button id="open">Settings</button><dialog><button data-dialog-close>Done</button><input value="unchanged"></dialog>';
  const dialog=doc.querySelector('dialog'),opener=doc.querySelector('#open');
  // Model native dialog state/events independently of happy-dom version.
  dialog.showModal=()=>{dialog.open=true;};
  dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new window.Event('close'));};
  let opens=0,closes=0;
  const binding=bindArenaDialog(dialog,opener,{onOpen(){opens++;},onClose(){closes++;}});
  opener.focus(); opener.click(); opener.click();
  assert.equal(opens,1); assert.equal(dialog.open,true); assert.equal(opener.getAttribute('aria-expanded'),'true');
  assert.equal(doc.activeElement,dialog.querySelector('button'));
  dialog.dispatchEvent(new window.Event('cancel',{cancelable:true}));
  assert.equal(closes,1); assert.equal(dialog.open,false); assert.equal(doc.activeElement,opener);
  opener.click(); dialog.querySelector('button').click();
  assert.equal(closes,2); assert.equal(dialog.querySelector('input').value,'unchanged');
  binding.destroy(); opener.click(); assert.equal(opens,2);
  await window.happyDOM.abort();
});


test('a rejected native dialog open cannot pause the owner or latch the binding', async () => {
  const window=new Window(),doc=window.document;
  doc.body.innerHTML='<button id="open" aria-expanded="false">Settings</button><dialog><button data-dialog-close>Done</button></dialog>';
  const dialog=doc.querySelector('dialog'),opener=doc.querySelector('#open');
  let opens=0,closes=0;
  dialog.showModal=()=>{throw new Error('disconnected dialog');};
  dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new window.Event('close'));};
  const binding=bindArenaDialog(dialog,opener,{onOpen(){opens++;},onClose(){closes++;}});
  assert.throws(()=>binding.open(),/disconnected/);
  assert.equal(binding.isOpen,false); assert.equal(opens,0); assert.equal(closes,0);
  assert.equal(opener.getAttribute('aria-expanded'),'false');
  dialog.showModal=()=>{dialog.open=true;};
  binding.open(); assert.equal(binding.isOpen,true); assert.equal(opens,1);
  binding.close(); assert.equal(closes,1); binding.destroy();
  await window.happyDOM.abort();
});
