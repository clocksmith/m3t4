// Browser tests follow the same mandatory detours as a player, using only
// visible cards. Restoring the interrupted app is an explicit test action.
export async function followDetour(page) {
 const tap=target=>page.locator(`[data-action="${target}"]`).click();
 if(await page.locator('.bait-shutters').count()) {
  for(let i=0;i<3;i++) {const tile=page.locator(`[data-action="bait:tile:${i}"]`);if(await tile.isEnabled())await tile.click();}
 } else if(await page.locator('.bait-cards').count()) {
  const known=new Map();
  for(let attempt=0;attempt<24 && !await page.locator('[data-action="bait:replies"]').count();attempt++) {
   if(await page.locator('[data-action="bait:reset"]').count())await tap('bait:reset');
   const cards=page.locator('.bait-cards button');
   const enabled=[];for(let i=0;i<6;i++)if(await cards.nth(i).isEnabled())enabled.push(i);
   let first=enabled.find(i=>!known.has(i))??enabled[0];await tap(`bait:tile:${first}`);known.set(first,await cards.nth(first).textContent());
   const second=enabled.find(i=>i!==first&&known.get(i)===known.get(first))??enabled.find(i=>i!==first&&!known.has(i))??enabled.find(i=>i!==first);
   await tap(`bait:tile:${second}`);known.set(second,await cards.nth(second).textContent());
  }
 } else if(await page.locator('[data-action="bait:stop"]').count())await tap('bait:stop');
 await tap('bait:replies');await tap('bait:react:laugh');await tap('bait:source');
}
export async function handleInterruption(page) {
 const before=JSON.parse(await page.locator('#phone-screen').getAttribute('data-screen')||'{"app":"home"}');
 for(let count=0;count<20 && await page.locator('.interrupting .notification-open').count();count++) {
  await page.locator('.interrupting .notification-open').click();
  if(await page.locator('.bait-app').count())await followDetour(page);
 }
 if(await page.locator('#next-round').count())return;
 await page.locator('#phone-home').click();
 if(before.app==='home')return;
 if(before.app==='switcher'){await page.locator('#phone-switcher').click();return;}
 if(before.app==='notifications'){await page.locator('#soundless-notifications').click();return;}
 await page.locator(`[data-action="app:${before.app}"]`).first().click();
 const target=before.contact?`contact:${before.contact}`:before.eventId?`event:${before.eventId}`:before.personId?`person:${before.personId}`:before.noteId?`note-open:${before.noteId}`:null;
 if(before.app==='notes'&&(before.list||before.noteId))await page.locator('[data-action="notes-list"]').click();
 if(before.edit)await page.locator(`[data-action="${before.app==='calendar'?'event':'person'}-resume"]`).click();
 else if(target)await page.locator(`[data-action="${target}"]`).click();
}
