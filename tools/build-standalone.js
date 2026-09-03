#!/usr/bin/env node
/**
 * Bundles the prototype into one self-contained HTML file, for sharing as a
 * link where there is no web server to serve css/ and js/ alongside it.
 *
 * Emits body content only — no <!doctype>, <html>, <head> or <body> tags —
 * because the publishing target wraps it in its own document skeleton. The
 * <title> and <style> lead the file so they still land in the head.
 *
 * Output is byte-for-byte derived from the real sources, so the shared link
 * and the local prototype can never drift.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const html = read('index.html');
const css = read('css/styles.css');

// Script order is the layered architecture: data → engine → ui → entry point.
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
if (scripts.length === 0) throw new Error('no <script src> tags found in index.html');

const body = html
  .slice(html.indexOf('<body>') + '<body>'.length, html.lastIndexOf('</body>'))
  .replace(/[ \t]*<script src="[^"]+"><\/script>\n?/g, '')
  .trim();

const title = /<title>([^<]+)<\/title>/.exec(html)?.[1] ?? 'Outcome Execution Engine';

const out = [
  `<title>${title}</title>`,
  '<style>',
  css.trim(),
  '</style>',
  '',
  body,
  '',
  ...scripts.flatMap((src) => [`<!-- ${src} -->`, '<script>', read(src).trim(), '</script>', '']),
].join('\n');

const target = process.argv[2] ?? 'dist/outcome-execution-engine.html';
mkdirSync(dirname(join(root, target)), { recursive: true });
writeFileSync(join(root, target), out);
console.log(`${target} — ${(out.length / 1024).toFixed(1)} KB, ${scripts.length} scripts inlined`);
