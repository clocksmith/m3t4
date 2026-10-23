import{chromium}from'playwright';
import{readFile}from'node:fs/promises';
import path from'node:path';
const root=path.resolve(process.argv[2]||'../artifacts');
const img=async file=>'data:image/png;base64,'+(await readFile(path.join(root,file))).toString('base64');
const before=await img('appearance-before/six-fighters.png'),after=await img('appearance-after/six-fighters.png');
const cardsBefore=await img('appearance-before/home-roster-390.png'),cardsAfter=await img('appearance-after/home-roster-390.png');
const game=await img('appearance-game/elon-1440-arena.png');
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage();
 await page.setContent(`<style>@page{size:1200px 900px;margin:20px}*{box-sizing:border-box}body{margin:0;font:20px Arial;color:#172238}h1{font-size:30px;margin:0 0 12px}p{line-height:1.4}section{height:860px;break-after:page;overflow:hidden}.sheet{width:1160px;height:680px;object-fit:cover;object-position:top;image-rendering:pixelated}.cards{display:flex;gap:24px}.cards img{width:550px;height:auto;image-rendering:pixelated}.game{width:1160px;height:660px;object-fit:contain}</style>
 <section><h1>Before: equal-scale roster review</h1><p>Actual home portrait crop at 96×96 CSS pixels. Battle bodies retain a shared 56px scale and are shown 2×, both facings.</p><img class="sheet" src="${before}"></section>
 <section><h1>After: matched head framing and appearance</h1><p>Jensen and Elon match the established portrait scale. Elon reads older and less idealized. Darrius has dark hair and a lighter complexion.</p><img class="sheet" src="${after}"></section>
 <section><h1>The surface in the user screenshot: mobile home cards</h1><div class="cards"><div><h2>Before</h2><img src="${cardsBefore}"></div><div><h2>After</h2><img src="${cardsAfter}"></div></div><p>The original screenshot was inspected locally as a 918×2048 PNG. Jensen and Elon's smaller heads were caused by internal portrait framing as well as different facial rendering. Crown padding changed from 13.9% to 4.7% for Jensen and 15.3% to 7.7% for Elon; Sama remains 5.2%.</p><p>Five accepted imagegen edits preserve transparent source PNGs. A measured crop is shared by home CSS and Canvas HUD. No weapon sockets, bone lengths, animation timelines or collision geometry changed.</p><p>106 client tests pass, including 17 focused checks. Six-fighter desktop/mobile captures, both facings and actual Duel UI pass. No Firebase deployment or Firestore migration in this pass.</p></section>
 <section><h1>Actual Duel canvas with corrected portrait and rig art</h1><p>Desktop capture. The same corrected assets and portrait framing are used in the HUD.</p><img class="game" src="${game}"></section>`);
 await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
 await page.pdf({path:path.join(root,'appearance-review.pdf'),printBackground:true,preferCSSPageSize:true});console.log(path.join(root,'appearance-review.pdf'));
}finally{await browser.close();}
