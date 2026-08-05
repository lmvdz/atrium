import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const port = Number(process.env.ATRIUM_RAW_THREAD_PORT ?? 3200);
const path = resolve(process.argv[2] ?? 'corpora/ts9998.jsonl');
const messages = readFileSync(path, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const rows = messages
  .map(
    (message, index) => `<article>
      <header><strong>${escapeHtml(message.author)}</strong><time>${escapeHtml(message.ts)}</time><span>${index + 1} / ${messages.length}</span></header>
      <pre>${escapeHtml(message.text)}</pre>
    </article>`,
  )
  .join('');

const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Raw chronological thread</title><style>
  :root { color-scheme: light; font: 14px/1.45 system-ui, sans-serif; }
  body { margin: 0; background: #f6f4ef; color: #25231f; }
  main { max-width: 880px; margin: 0 auto; padding: 28px 24px 80px; }
  h1 { font-size: 19px; margin: 0; }
  .lede { color: #625e55; margin: 4px 0 24px; }
  article { border-top: 1px solid #d8d3c9; padding: 12px 0 14px; }
  header { align-items: baseline; display: flex; gap: 10px; }
  header time, header span { color: #746f65; font: 11px/1.4 ui-monospace, monospace; }
  header span { margin-left: auto; }
  pre { font: inherit; margin: 7px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
</style></head><body><main><h1>Raw chronological thread</h1>
<p class="lede">${messages.length} messages · oldest first · no summary, filters, or derived state</p>${rows}</main></body></html>`;

const server = createServer((request, response) => {
  if (request.url !== '/') {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(page);
});

server.listen(port, '127.0.0.1', () => {
  console.info(`raw thread: http://127.0.0.1:${port}/ (${messages.length} messages)`);
});
