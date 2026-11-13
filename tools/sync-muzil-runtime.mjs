// Copy sibling library sources; never model weights, node_modules, credentials, or symlinks.
import { readdir, readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const entries = { reploid: 'packages/reploid/src/transport/assignment.js', doppler: 'src/index.js' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function syncMuzilRuntime({ root = repositoryRoot, check = false, log = console.log } = {}) {
  const destination = resolve(root, 'client/vendor');
  const report = { schema: 'muzil.local-runtimes/v1', libraries: {} };
  let written = 0, removed = 0, modelManifestBytes;
  const stat = async file => lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  async function ensureDirectory(directory) {
    if (directory === resolve(root)) return;
    await ensureDirectory(dirname(directory));
    const existing = await stat(directory);
    if (existing && !existing.isDirectory()) throw new Error(`Not a regular output directory: ${directory}`);
    if (!existing && !check) await mkdir(directory);
  }
  async function syncFile(file, bytes) {
    await ensureDirectory(dirname(file));
    const existing = await stat(file);
    if (existing && !existing.isFile()) throw new Error(`Not a regular output file: ${file}`);
    if (existing && (await readFile(file)).equals(bytes)) return;
    if (check) throw new Error(`${relative(root, file)} needs npm run sync:runtime`);
    await writeFile(file, bytes); written++;
  }
  async function prune(directory, expected, prefix = '') {
    await ensureDirectory(dirname(directory));
    const existing = await stat(directory);
    if (!existing) return;
    if (!existing.isDirectory()) throw new Error(`Not a regular output directory: ${directory}`);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const rel = prefix + item.name, file = resolve(directory, item.name);
      if (item.isDirectory()) await prune(file, expected, rel + '/');
      else if (!expected.has(rel)) {
        if (check) throw new Error(`Stale runtime file: ${file}`);
        await rm(file); removed++;
      } else if (!item.isFile()) throw new Error(`Not a regular output file: ${file}`);
    }
  }
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
    const files = {}, contents = new Map();
    for (const rel of [...paths].sort()) {
      const file = resolve(source, rel);
      if (!(await lstat(file)).isFile()) throw new Error(`Not a regular source file: ${rel}`);
      const bytes = await readFile(file); contents.set(rel, bytes); files[rel] = hash(bytes);
    }
    if (name === 'doppler') modelManifestBytes = contents.get('models/local/create-gemma-3-1b-qualification/manifest.json');
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    const sourceDirty = !!execFileSync('git', ['status', '--porcelain', '--', name === 'doppler' ? 'src' : 'packages/reploid/src'], { cwd: source, encoding: 'utf8' }).trim();
    report.libraries[name] = { revision, sourceDirty, entry, files };
    const expected = new Set([...paths, 'package.json']);
    if (name === 'doppler') expected.add('models/muzil-gemma-1b/manifest.json');
    await prune(resolve(destination, name), expected);
    for (const [rel, bytes] of contents) await syncFile(resolve(destination, name, rel), bytes);
    await syncFile(resolve(destination, name, 'package.json'), Buffer.from('{"type":"module"}\n'));
    log(`${name}: ${paths.size} local files @ ${revision.slice(0, 8)}${sourceDirty ? ' (working tree changes)' : ''}`);
  }
  const modelManifest = resolve(destination, 'doppler/models/muzil-gemma-1b/manifest.json');
  await syncFile(modelManifest, modelManifestBytes);
  const sourceSummary = JSON.stringify({ schema: report.schema, libraries: Object.fromEntries(Object.entries(report.libraries).map(([name, item]) => [name, { revision:item.revision, sourceDirty:item.sourceDirty, entry:item.entry, files:Object.keys(item.files).length, digest:hash(JSON.stringify(item.files)) }])) },null,2) + '\n';
  const lockPath = resolve(root,'client/muzil/runtime-sources.json');
  await syncFile(lockPath, Buffer.from(sourceSummary));
  const encoded = JSON.stringify(report, null, 2) + '\n';
  await syncFile(resolve(destination, 'manifest.json'), Buffer.from(encoded));
  return { report, written, removed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncMuzilRuntime({ check: process.argv.includes('--check') });
}
