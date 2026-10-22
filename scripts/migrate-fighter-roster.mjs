#!/usr/bin/env node
// Explicit, resumable metadata backfill. No matches, replays, handles, combat
// attributes, ratings, submission times or permissions are rewritten.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { migrateFighterRoster } from '../client/lib/fighter-roster.mjs';

export function migrateRosterDocument(document, behaviorVersion) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw Error('expected a roster store object');
  if (!document.stables || typeof document.stables !== 'object' || Array.isArray(document.stables)) throw Error('expected stables keyed by stable ID');
  let fighters = 0, changedFighters = 0, changedStables = 0;
  const stables = Object.fromEntries(Object.entries(document.stables).map(([id, stable]) => {
    if (stable.userId !== id) throw Error(`stable key and userId disagree: ${id}`);
    const next = migrateFighterRoster(stable, behaviorVersion);
    for (let i=0; i<(stable.slots ?? []).length; i++) {
      if (!stable.slots[i]) continue;
      fighters++;
      if (next.slots[i] !== stable.slots[i]) changedFighters++;
    }
    if (next !== stable) changedStables++;
    return [id, next];
  }));
  return { document: changedStables ? { ...document, stables } : document,
    report: { behaviorVersion, stables: Object.keys(stables).length, fighters, changedStables, changedFighters } };
}

async function preserveBackup(file, bytes) {
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const backup = `${file}.before-fighter-migration-${digest.slice(0,16)}.json`;
  try { await fs.writeFile(backup, bytes, { flag:'wx', mode:0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!(await fs.readFile(backup)).equals(Buffer.from(bytes))) throw Error('existing backup bytes do not match');
  }
  return { backup, sha256:digest };
}

export async function migrateFile(file, behaviorVersion, apply = false) {
  const bytes = await fs.readFile(file);
  const result = migrateRosterDocument(JSON.parse(bytes), behaviorVersion);
  const report = { ...result.report, applied:false };
  if (apply && result.report.changedStables) {
    Object.assign(report, await preserveBackup(file,bytes));
    const temporary = `${file}.migration-${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(result.document,null,2)+'\n', {flag:'wx',mode:(await fs.stat(file)).mode & 0o777});
    // Refuse a concurrent writer instead of overwriting its changes.
    if (!(await fs.readFile(file)).equals(bytes)) {
      await fs.unlink(temporary);
      throw Error('roster changed during migration; retry from the new source');
    }
    await fs.rename(temporary,file);
    report.applied = true;
  }
  return report;
}

async function migrateFirestore(projectId, behaviorVersion, apply, backupPath) {
  if (!projectId) throw Error('--project is required for Firestore');
  if (apply && !backupPath) throw Error('--backup is required before Firestore writes');
  const {initializeApp,applicationDefault} = await import('firebase-admin/app');
  const {getFirestore,FieldPath} = await import('firebase-admin/firestore');
  const app = initializeApp({projectId,credential:applicationDefault()}, 'fighter-roster-migration');
  const db = getFirestore(app);
  const projection = apply ? await import('../functions/dist/public-bots.js') : null;
  const stableProjection = apply ? await import('../functions/dist/stable-public.js') : null;
  const backup = backupPath ? await fs.open(backupPath,'ax',0o600) : null;
  try {
    return await migrateFirestoreRoster({firestore:db,projectId,behaviorVersion,apply,backup,
      orderField:FieldPath.documentId(),projectStable:stableProjection?.publicStableDoc,
      projectBots:projection?.writePublicBotProjection});
  } finally { await backup?.close(); await db.terminate(); }
}

export async function migrateFirestoreRoster({firestore:db,projectId,behaviorVersion,apply=false,
  backup=null,orderField='__name__',projectStable,projectBots,pageSize=100}) {
  if (apply && (!backup || !projectStable || !projectBots)) throw Error('apply requires durable backup and public projections');
  let cursor=null,scanned=0,fighters=0,changed=0;
  while(true) {
    let query=db.collection('stables').orderBy(orderField).limit(pageSize);
    if(cursor) query=query.startAfter(cursor);
    const page=await query.get();
    if(!page.docs.length) break;
    for(const doc of page.docs) {
      scanned++;
      const source=doc.data();
      fighters+=(source.slots ?? []).filter(Boolean).length;
      if(source.userId!==doc.id) throw Error(`stable document and userId disagree: ${doc.id}`);
      if(migrateFighterRoster(source,behaviorVersion)===source) continue;
      if(!apply) {changed++;continue;}
      const updated=await db.runTransaction(async tx=>{
        const fresh=await tx.get(doc.ref);
        if(!fresh.exists) return false;
        const original=fresh.data();
        if(original.userId!==doc.id) throw Error(`stable identity changed during migration: ${doc.id}`);
        const next=migrateFighterRoster(original,behaviorVersion);
        if(next===original) return false;
        // Durable originals include aliases and private configs; keep this
        // operator-owned backup private, never in public match artifacts.
        await backup.write(JSON.stringify({projectId,collection:'stables',id:doc.id,original})+'\n');
        await backup.sync();
        tx.update(doc.ref,{slots:next.slots});
        tx.set(db.collection('publicStables').doc(doc.id),projectStable(next),{merge:true});
        projectBots(tx,db,next);
        return true;
      });
      if(updated) changed++;
    }
    cursor=page.docs.at(-1);
  }
  return {projectId,behaviorVersion,stables:scanned,fighters,changedStables:changed,applied:apply};
}

async function main() {
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...v]=arg.replace(/^--/,'').split('=');return [key,v.length?v.join('='):true]}));
  const {BEHAVIOR_VERSION}=await import('../sim/dist/index.js');
  if (args['expected-version'] && Number(args['expected-version'])!==BEHAVIOR_VERSION) throw Error('installed AI version differs from expected-version');
  const apply=args.apply===true;
  const report=args.file ? await migrateFile(path.resolve(args.file),BEHAVIOR_VERSION,apply)
    : args.firestore ? await migrateFirestore(args.project,BEHAVIOR_VERSION,apply,args.backup)
    : (()=>{throw Error('use --file=/path/store.json or --firestore --project=ID; dry-run by default, --apply requires a backup')})();
  console.log(JSON.stringify(report,null,2));
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1});
