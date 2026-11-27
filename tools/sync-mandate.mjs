// Gamma owns game sources and the public deployment allowlist; m3t4 owns hosting.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const gamma = new URL('../../gamma/', import.meta.url);
const source = ['apps/mandate-2038', 'apps/games/2038', 'games/2038']
  .map(directory => fileURLToPath(new URL(`${directory}/`, gamma)))
  .find(directory => existsSync(join(directory, 'package.json')));
if (!source) throw new Error('Mandate source is missing from the adjacent Gamma checkout');
const destination = fileURLToPath(new URL('../client/mandate-2038/', import.meta.url));
execFileSync('npm', ['run', 'publish:firebase:build'], { cwd: source, stdio: 'inherit' });
const published = join(source, 'dist/firebase/public');
const manifest = JSON.parse(readFileSync(join(published, 'site-manifest.json'), 'utf8'));
if (manifest.deploymentProfile !== 'public-playtest' || manifest.deployable !== true || manifest.publicBase !== '/mandate-2038') {
  throw new Error('Mandate must be the deployable public-playtest build for /mandate-2038');
}
rmSync(destination, { recursive: true, force: true });
cpSync(published, destination, { recursive: true });

// Hosting owns the shared analytics wrapper; Gamma's game bundle stays unchanged.
const entry = join(destination, 'index.html');
const html = readFileSync(entry, 'utf8');
writeFileSync(entry, html.replace('</body>', '<script src="/config.js"></script>\n<script type="module" src="/lib/site-analytics.js"></script>\n</body>'));
