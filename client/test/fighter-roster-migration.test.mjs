import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {migrateFighterRoster} from '../lib/fighter-roster.mjs';
import {migrateRosterDocument,migrateFile} from '../../scripts/migrate-fighter-roster.mjs';

const makeStable=()=>({userId:'player-1',handle:'keep_handle',slots:Array.from({length:7},(_,i)=>({slotId:`id-${i}`,name:`old ${i}`,config:{id:`build-${i}`,attributes:{burnRate:3+i}},elo:1337+i,wins:i,submittedAt:12,lastPlayedAt:34})),updatedAt:56});
test('migration upgrades all saved seats, not only four active seats, preserving combat and identity',()=>{
 const stable=makeStable(),before=structuredClone(stable),migrated=migrateFighterRoster(stable,26);
 assert.deepEqual(stable,before);assert.equal(migrated.handle,stable.handle);assert.equal(migrated.updatedAt,56);
 for(let i=0;i<7;i++){
  const next=migrated.slots[i],old=stable.slots[i];
  assert.equal(next.aiBehaviorVersion,26);assert.notEqual(next.name,old.name);assert.deepEqual(next.previousNames,[old.name]);
  assert.equal(next.config,old.config);assert.equal(next.slotId,old.slotId);assert.equal(next.elo,old.elo);assert.equal(next.wins,old.wins);assert.equal(next.submittedAt,old.submittedAt);
 }
 assert.equal(migrateFighterRoster(migrated,26),migrated);
 migrated.slots[0].name='my edited name';assert.equal(migrateFighterRoster(migrated,26).slots[0].name,'my edited name');
 assert.equal(migrateFighterRoster(migrated,25),migrated);
});
test('complete bundled roster migrates, archives and handles remain byte-equivalent',async()=>{
 const source=JSON.parse(await fs.readFile(new URL('../../data/m3t4.json',import.meta.url),'utf8'));
 const archive={signed:true,name:'historic name',actionLog:'abc',sim:{behaviorVersion:24}};
 source.replays={original:archive};source.matches={historic:archive};
 const result=migrateRosterDocument(source,26);
 assert.equal(result.report.fighters,Object.values(source.stables).reduce((n,s)=>n+s.slots.filter(Boolean).length,0));
 assert.ok(result.report.changedFighters<=result.report.fighters);
 for(const stable of Object.values(result.document.stables)) for(const slot of stable.slots.filter(Boolean)) {assert.equal(slot.aiBehaviorVersion,26);assert.equal(slot.fighterNameVersion,1);}
 assert.equal(result.document.replays,source.replays);assert.equal(result.document.matches,source.matches);assert.equal(result.document.handles,source.handles);
 assert.equal(migrateRosterDocument(result.document,26).report.changedFighters,0);
});
test('file migration defaults to dry-run, backs up exact original, and repeated apply is a no-op',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fighter-migration-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const file=path.join(dir,'roster.json'),bytes=JSON.stringify({stables:{'player-1':makeStable()},replays:{keep:{name:'old'}}});
 await fs.writeFile(file,bytes);assert.equal((await migrateFile(file,26)).applied,false);assert.equal(await fs.readFile(file,'utf8'),bytes);
 const applied=await migrateFile(file,26,true);assert.equal(applied.applied,true);assert.equal(await fs.readFile(applied.backup,'utf8'),bytes);
 const changed=await fs.readFile(file,'utf8');assert.equal((await migrateFile(file,26,true)).applied,false);assert.equal(await fs.readFile(file,'utf8'),changed);
});

test('full Firestore backfill pages through inactive stables, re-reads concurrent stats, and resumes idempotently',async()=>{
 const {migrateFirestoreRoster}=await import('../../scripts/migrate-fighter-roster.mjs');
 const records=new Map(Array.from({length:5},(_,i)=>{const s=makeStable();s.userId=`player-${i}`;s.lastActiveAt=0;return [s.userId,s]}));
 let writes=0,projections=0,backups=[],syncs=0,readPages=0;
 const snap=id=>({id,ref:{id},exists:records.has(id),data:()=>structuredClone(records.get(id))});
 const db={collection(name){return {doc(id){return {id,collection:name}},orderBy(){let count=0,after='';return {limit(n){count=n;return this},startAfter(doc){after=doc.id;return this},async get(){readPages++;return {docs:[...records.keys()].filter(id=>id>after).slice(0,count).map(snap)}}}}}},async runTransaction(fn){return fn({async get(ref){records.get(ref.id).slots[0].wins=9000;return snap(ref.id)},update(ref,data){writes++;records.set(ref.id,{...records.get(ref.id),...data})},set(){projections++}})}};
 const backup={async write(text){backups.push(JSON.parse(text))},async sync(){syncs++}};
 const base={firestore:db,projectId:'test-project',behaviorVersion:26,pageSize:2};
 const dry=await migrateFirestoreRoster(base);
 assert.equal(dry.stables,5);assert.equal(dry.fighters,35);assert.equal(writes,0);assert.equal(readPages,4);
 const result=await migrateFirestoreRoster({...base,apply:true,backup,projectStable:s=>s,projectBots:()=>{}});
 assert.equal(result.changedStables,5);assert.equal(writes,5);assert.equal(projections,5);assert.equal(backups.length,5);assert.equal(syncs,5);
 for(const s of records.values()) {assert.equal(s.slots[0].wins,9000);assert.ok(s.slots.every(slot=>slot.aiBehaviorVersion===26));}
 for(const saved of backups) assert.equal(saved.original.slots[0].wins,9000);
 assert.equal((await migrateFirestoreRoster({...base,apply:true,backup,projectStable:s=>s,projectBots:()=>{}})).changedStables,0);
 assert.equal(writes,5);
 await assert.rejects(migrateFirestoreRoster({...base,apply:true}),/durable backup/);
});
