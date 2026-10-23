import {chromium} from 'playwright';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.argv[2]||'../artifacts');
const img=async file=>'data:image/png;base64,'+(await readFile(path.join(root,file))).toString('base64');
const files=['headscale-v3-before/six-fighters.png','headscale-v3-after/six-fighters.png','headscale-v3-before/home-roster-390.png','headscale-v3-after/home-roster-390.png','headscale-v3-game/elon-1440-arena.png','headscale-v3-game/jensen-390-arena.png'];
const [before,after,cardsBefore,cardsAfter,elon,jensen]=await Promise.all(files.map(img));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage();
  await page.setContent(`<style>@page{size:1200px 900px;margin:20px}*{box-sizing:border-box}body{margin:0;font:20px Arial;color:#172238}h1{font-size:30px;margin:0 0 12px}p{line-height:1.4}section{height:860px;break-after:page;overflow:hidden}.sheet{width:1160px;height:680px;object-fit:cover;object-position:top;image-rendering:pixelated}.cards{display:flex;gap:24px}.cards img{width:550px;image-rendering:pixelated}.game{width:1160px;height:650px;object-fit:contain}table{border-collapse:collapse}td,th{padding:8px 24px;border:1px solid #ccd}</style>
  <section><h1>Before: source b48e6dd</h1><p>All six at the same 96px portrait viewport. Shared 56px battle bodies shown 2×, both facings.</p><img class="sheet" src="${before}"></section>
  <section><h1>After: larger heads, pale sparse-haired Elon, gray-haired Jensen</h1><p>Mark and Demis are the scale references. Darius retains his approved dark hair and lighter complexion.</p><img class="sheet" src="${after}"></section>
  <section><h1>Actual mobile home cards</h1><div class="cards"><div><h2>Before</h2><img src="${cardsBefore}"></div><div><h2>After</h2><img src="${cardsAfter}"></div></div><p>Visible median head-band widths at 96px: Jensen ≈51→59px; Elon ≈44→58px. Mark ≈64px and Demis ≈49px remain unchanged. Measurement samples actual opaque pixels through forehead, eyes and cheeks, rather than atlas dimensions.</p><p>Four imagegen edits preserve transparent PNG sources; shared crop metadata controls home/HUD scale. All 107 client tests pass. Desktop/mobile browser checks show no page errors or overflow. Weapon sockets, animation and collision geometry remain unchanged. Source-only: deployment held for review.</p></section>
  <section><h1>Actual desktop Duel HUD: Elon</h1><p>Larger pale face and sparse receding hair, retaining older features.</p><img class="game" src="${elon}"></section>
  <section><h1>Actual mobile Duel HUD: Jensen</h1><p>Larger head framing and gray hair. Browser mobile emulation; physical-device and live two-peer qualification are not claimed.</p><img class="game" src="${jensen}"></section>`);
  await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
  await page.pdf({path:path.join(root,'headscale-v3-review.pdf'),printBackground:true,preferCSSPageSize:true});
  console.log(path.join(root,'headscale-v3-review.pdf'));
}finally{await browser.close();}
