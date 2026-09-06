import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = "client/app.css";
const TOKEN_FILE = "client/styles/tokens.css";
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const clean = text => text.replace(/\/\*[\s\S]*?\*\//g, '');
const imports = text => [...clean(text).matchAll(/@import\s+['"]([^'"]+)['"]\s*;/g)].map(match => match[1]);
function closure(file, stack = []) {
  assert.ok(!stack.includes(file), 'stylesheet import cycle: ' + [...stack, file].join(' -> '));
  const text = read(file);
  const children = imports(text).flatMap(ref => {
    assert.ok(ref.startsWith('.'), 'local relative stylesheet import required: ' + ref);
    const child = path.normalize(path.join(path.dirname(file), ref));
    assert.ok(!child.startsWith('..'), 'stylesheet escapes repository: ' + child);
    return closure(child, [...stack, file]);
  });
  return [{file, text}, ...children];
}

test('public stylesheet resolves the owned design layers without duplicate loading', () => {
  const files = closure(ENTRY).map(row => row.file);
  assert.equal(new Set(files).size, files.length);
  for (const layer of ["tokens.css","primitives.css","components/controls.css","compositions/duel.css"]) assert.ok(imports(read(ENTRY)).some(ref => ref.endsWith(layer)), layer);
  assert.equal(clean(read(ENTRY)).replace(/@import\s+['"][^'"]+['"]\s*;/g, '').trim(), '', 'entry is composition only');
});

test('literal paint values belong to tokens, not component and page rules', () => {
  const files = closure(ENTRY);
  const tokens = read(TOKEN_FILE);
  const definitions = new Set([...tokens.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]));
  for (const {file, text} of files) {
    if (file === TOKEN_FILE) continue;
    const css = clean(text).replace(/url\([^)]*\)/g, '');
    const values = [...css.matchAll(/(?:^|[;{])\s*[-\w]+\s*:\s*([^;{}]+)/g)].map(match => match[1]).join('\n');
    assert.doesNotMatch(values, /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?)\(\s*[-.\d]/i, file + ' must consume paint tokens');
    for (const [, name] of css.matchAll(/var\(\s*(--[\w-]*paint-[\w-]+)/g)) assert.ok(definitions.has(name), file + ': missing ' + name);
  }
});

test('page entries use stylesheets instead of inline stylesheet forks', () => {
  for (const file of ["client/index.html"]) assert.doesNotMatch(read(file), /<style(?:\s|>)/i, file);
});

test('UI and weapon effects do not reintroduce pink accent paint', () => {
  for (const file of [TOKEN_FILE, 'client/render/canvas2d.js', 'theming/weapons.ts']) {
    assert.doesNotMatch(clean(read(file)), /#(?:ec4899|be185d|f472b6|d946ef)\b|--ui-pink|\bhotpink\b/i);
  }
  const theme = JSON.parse(read('theming/visual-theme.v1.json'));
  // Generation's magenta chroma-key and natural skin descriptions are not UI accents.
  assert.doesNotMatch(JSON.stringify(theme.weaponVisuals), /#(?:ec4899|be185d|f472b6|d946ef)\b/i);
});
