// Copy sibling library sources; never model weights, node_modules, credentials, or symlinks.
import { readdir, readFile, writeFile, mkdir, rm, copyFile, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const destination = resolve(root, 'client/vendor');
const check = process.argv.includes('--check');
const entries = { reploid: 'packages/reploid/src/transport/assignment.js', doppler: 'src/index.js' };
const report = { schema: 'muzil.local-runtimes/v1', libraries: {} };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [name, entry] of Object.entries(entries)) {
  const source = resolve(root, '..', name), paths = new Set();
  const visit = async rel => {
    if (paths.has(rel)) return;
    const absolute = resolve(source, rel);
    if (!absolute.startsWith(source + sep)) throw new Error('Import escapes source repository');
    if (!(await lstat(absolute)).isFile()) throw new Error(`Not a regular source file: ${rel}`);
    const data = await readFile(absolute, 'utf8'); paths.add(rel);
    if (!rel.endsWith('.js')) return;
    for (const match of data.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      await visit(relative(source, resolve(dirname(absolute), match[1])));
    }
  };
  if (name === 'reploid') {
    for (const path of [entry, 'packages/reploid/src/mesh/partitions/partition-link.js', 'packages/reploid/src/mesh/partitions/partition-entry.js', 'packages/reploid/src/mesh/partitions/partition-chat.js', 'packages/reploid/src/mesh/partitions/partition-peer.js', 'packages/reploid/src/mesh/partitions/resident-partition.js', 'packages/reploid/src/mesh/partitions/partition-grants.js', 'packages/reploid/src/artifacts/custody/piece-acquisition.js']) await visit(path);
  }
  else {
    // Doppler resolves kernels/configuration dynamically. Preserve its complete runtime
    // source tree rather than guessing a static import closure and missing shader assets.
    const walk = async dir => {
      for (const item of await readdir(resolve(source, dir), { withFileTypes: true })) {
        const rel = dir + '/' + item.name;
        if (item.isDirectory()) await walk(rel);
        else if (item.isFile() && ['.js', '.json', '.wgsl', '.wasm'].includes(extname(rel))) paths.add(rel);
      }
    };
    await walk('src');
    paths.add('models/local/create-gemma-3-1b-qualification/manifest.json');
    paths.add('models/partition-pieces/gemma-3-1b.json');
  }
  paths.add('LICENSE');
  const files = {};
  for (const rel of [...paths].sort()) { const file = resolve(source,rel); if (!(await lstat(file)).isFile()) throw new Error(`Not a regular source file: ${rel}`); files[rel] = hash(await readFile(file)); }
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  const sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--', name === 'doppler' ? 'src' : 'packages/reploid/src'], { cwd: source, encoding: 'utf8' }).trim();
  report.libraries[name] = { revision, sourceDirty, entry, files };
  if (check) {
    for (const rel of paths) {
      const actual = hash(await readFile(resolve(destination, name, rel)).catch(() => Buffer.from('missing')));
      if (actual !== files[rel]) throw new Error(`${name}/${rel} needs npm run sync:runtime`);
    }
  } else {
    await rm(resolve(destination, name), { recursive: true, force: true });
    for (const rel of paths) { const to = resolve(destination, name, rel); await mkdir(dirname(to), { recursive: true }); await copyFile(resolve(source, rel), to); }
    // Explicit ESM package boundary also allows Node contract tests against these copies.
    await writeFile(resolve(destination, name, 'package.json'), '{"type":"module"}\n');
  }
  console.log(`${name}: ${paths.size} local files @ ${revision.slice(0, 8)}${sourceDirty ? ' (working tree changes)' : ''}`);
}
const modelManifest = resolve(destination, 'doppler/models/muzil-gemma-1b/manifest.json');
const sourceManifest = resolve(root, '../doppler/models/local/create-gemma-3-1b-qualification/manifest.json');
if (check) { if (hash(await readFile(modelManifest)) !== hash(await readFile(sourceManifest))) throw new Error('Model manifest needs synchronization'); }
else { await mkdir(dirname(modelManifest), {recursive:true}); await copyFile(sourceManifest, modelManifest); }
const sourceSummary = JSON.stringify({ schema: report.schema, libraries: Object.fromEntries(Object.entries(report.libraries).map(([name, item]) => [name, { revision:item.revision, sourceDirty:item.sourceDirty, entry:item.entry, files:Object.keys(item.files).length, digest:hash(JSON.stringify(item.files)) }])) },null,2) + '\n';
const lockPath = resolve(root,'client/muzil/runtime-sources.json');
if (check) { if (await readFile(lockPath,'utf8') !== sourceSummary) throw new Error('Source lock differs; sync runtime again'); }
else await writeFile(lockPath,sourceSummary);
const encoded = JSON.stringify(report, null, 2) + '\n';
if (check) {
  if (await readFile(resolve(destination, 'manifest.json'), 'utf8') !== encoded) throw new Error('Runtime source identity changed; sync again');
} else await writeFile(resolve(destination, 'manifest.json'), encoded);
