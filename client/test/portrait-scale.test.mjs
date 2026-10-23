import test from 'node:test';
import assert from 'node:assert/strict';
import {BODY_PORTRAIT_SHEETS,portraitCellCrop,portraitSourceRect,portraitBackgroundStyle} from '../content/character-presentation.js';
import {readRgbaPng} from './png-rgba.mjs';

// Visible head spans through the forehead/eyes/cheeks, measured from opaque
// pixels at equal rendered size; transparent atlas dimensions cannot prove scale.
function headWidth(body){
  const png=readRgbaPng(new URL('../'+BODY_PORTRAIT_SHEETS[body],import.meta.url));
  const [sx,sy,sw,sh]=portraitSourceRect(body,0,png.width,png.height),spans=[];
  for(let row=0;row<=12;row++){
    const y=Math.floor(sy+sh*(.25+row*.025)),xs=[];
    for(let x=0;x<sw;x++)if(png.alpha(Math.floor(sx+x),y)>200)xs.push(x);
    spans.push(xs.length?(xs.at(-1)-xs[0]+1)/sw*96:0);
  }
  return spans.sort((a,b)=>a-b)[6];
}
test('Jensen and Elon visible heads match the Mark/Demis reference range in shared home/HUD framing',()=>{
  const reference=(headWidth('mark')+headWidth('demis'))/2;
  for(const body of ['jensen','elon']){
    const width=headWidth(body);
    assert.ok(width>=reference*.95&&width<=reference*1.12,`${body}: ${width}px versus reference ${reference}px`);
  }
});

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
