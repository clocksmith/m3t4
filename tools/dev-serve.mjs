// Static development server with explicit historical routes. No production writes.
import { createServer } from 'node:http';
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../client/', import.meta.url));
const historical = new Set(['history','history/','rules','intro','tune','live','duel','roster','about','compute','build','profile','spectate']);
const modelRedirects = JSON.parse(readFileSync(fileURLToPath(new URL('../firebase.json', import.meta.url)), 'utf8')).hosting.redirects || [];
const MIME = { '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.html':'text/html', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.ico':'image/x-icon', '.wasm':'application/wasm', '.ttf':'font/ttf', '.wgsl':'text/plain' };
export function createDevServer({ modelRoot = null } = {}) {
  return createServer((req,res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
      const redirect = modelRedirects.find(row => row.source === pathname);
      if (redirect && !modelRoot) { res.writeHead(redirect.type,{Location:redirect.destination});res.end();return; }
      let root = ROOT, rel = pathname.replace(/^\/+/, '');
      if (redirect && modelRoot) { root = resolve(modelRoot,'gemma-3-1b-it-q4k-ehf16-af32'); rel = pathname.split('/').at(-1); }
      else if (modelRoot && rel.startsWith('__models/')) { root = resolve(modelRoot); rel = rel.slice(9); if (!['.json','.bin'].includes(extname(rel))) throw new Error('Missing'); }
      else if (historical.has(rel)) rel = 'history/index.html';
      else if (!rel) rel = 'index.html';
      let file = resolve(root, rel);
      if (statSync(file).isDirectory()) file = resolve(file, 'index.html');
      if (!file.startsWith(resolve(root) + sep) || !statSync(file).isFile()) throw new Error('Missing');
      const size = statSync(file).size;
      const headers = { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control':'no-store', 'Accept-Ranges':'bytes' };
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (match) {
        const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]),size-1) : size-1;
        if (start > end || start >= size) { res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return; }
        res.writeHead(206,{...headers,'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${size}`});
        createReadStream(file,{start,end}).pipe(res);
      } else { res.writeHead(200,{...headers,'Content-Length':size}); createReadStream(file).pipe(res); }
    } catch { res.writeHead(404, {'Content-Type':'text/plain'}); res.end('Not found'); }
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 7788);
  createDevServer({ modelRoot: process.argv.includes('--local-models') ? resolve(ROOT, '../../doppler/models/local') : null }).listen(port, process.env.HOST || '127.0.0.1', () => console.log(`m3t4 preview: http://localhost:${port}/`));
}
