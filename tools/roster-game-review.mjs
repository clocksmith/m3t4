import{chromium}from'playwright';
import{createDevServer}from'./dev-serve.mjs';
import{mkdir,writeFile}from'node:fs/promises';
import path from'node:path';
const output=path.resolve(process.argv[2]||'test-results/roster-game');await mkdir(output,{recursive:true});
const server=createDevServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true});
const report=[];
try{
  for(const width of [1440,390]){
    const page=await browser.newPage({viewport:{width,height:1000},deviceScaleFactor:1,isMobile:width===390,hasTouch:width===390}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
    await page.goto(origin+'/duel');await page.waitForSelector('#duel-start');
    for(const [body,weapon] of [['elon','orbit_lance'],['mark','controller_nunchucks'],['sama','worldcoin_orb_flail']]){
      // Real controls select the body and weapon; the local stepper owns motion.
      const bodyButton=page.locator(`.duel-body-option[data-side="0"][data-body="${body}"]`);
      await page.locator('#arena-settings').click();
      await page.locator('#duel-reset').click();
      await bodyButton.evaluate(el=>{for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;});
      await bodyButton.click();await page.locator(`.duel-weapon-option[data-side="0"][data-weapon="${weapon}"]`).click();
      await page.locator('[data-dialog-close]').click();
      await page.locator('#duel-start').click();
      await page.waitForFunction(()=>performance.getEntriesByType('resource').some(r=>r.name.includes('/rig-v1/')));
      await page.keyboard.down('KeyF');await page.waitForTimeout(180);
      await page.locator('canvas').first().screenshot({path:path.join(output,`${body}-${width}-arena.png`)});
      await page.keyboard.up('KeyF');
    }
    await page.screenshot({path:path.join(output,`duel-${width}.png`),fullPage:true});
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    report.push({width,errors,overflow});if(errors.length||overflow)throw Error(JSON.stringify(report.at(-1)));
    await page.close();
  }
  await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(output);
}finally{await browser.close();await new Promise(r=>server.close(r));}
