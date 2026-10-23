import test from 'node:test';
import assert from 'node:assert/strict';
import {BODY_PORTRAIT_SHEETS,portraitCellCrop,portraitSourceRect,portraitBackgroundStyle} from '../content/character-presentation.js';
import {readRgbaPng} from './png-rgba.mjs';

test('actual neutral portrait pixels have a common crown baseline instead of undersized inset heads',()=>{
  for(const [body,url] of Object.entries(BODY_PORTRAIT_SHEETS)){
    const png=readRgbaPng(new URL('../'+url,import.meta.url));
    const [sx,sy,sw,sh]=portraitSourceRect(body,0,png.width,png.height);
    let top=sh;
    for(let y=0;y<sh;y++){
      let opaque=0;for(let x=0;x<sw;x++)if(png.alpha(Math.floor(sx+x),Math.floor(sy+y))>200)opaque++;
      if(opaque>sw*.08){top=y;break;}
    }
    assert.ok(top/sh<=.1,`${body}: crown must occupy the top 10% of the common viewport, actual ${top/sh}`);
    assert.ok(sw>0&&sh>0&&sx+sw<=png.width&&sy+sh<=png.height);
  }
});
test('CSS and Canvas address the same portrait pixels for every expression and resolution',()=>{
  for(const body of Object.keys(BODY_PORTRAIT_SHEETS))for(let cell=0;cell<4;cell++)for(const side of[192,1254]){
    const style=portraitBackgroundStyle(body,cell),[x,y,w,h]=portraitCellCrop(body,cell);
    const size=/background-size:([\d.]+)% ([\d.]+)%/.exec(style),position=/background-position:([\d.]+)% ([\d.]+)%/.exec(style);
    const [sx,sy,sw,sh]=portraitSourceRect(body,cell,side,side);
    assert.ok(Math.abs(side/(Number(size[1])/100)-sw)<1e-7);
    assert.ok(Math.abs(side/(Number(size[2])/100)-sh)<1e-7);
    assert.ok(Math.abs((side-sw)*Number(position[1])/100-sx)<1e-7);
    assert.ok(Math.abs((side-sh)*Number(position[2])/100-sy)<1e-7);
    if(cell===3)assert.deepEqual([x,y,w,h],[0,0,1,1],'full-body cell keeps its authored frame');
  }
});
