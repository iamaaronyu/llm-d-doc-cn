// 轻量静态构建器：在无法安装 Docusaurus 依赖时，把 docs/ 渲染成一套自包含的静态 HTML。
// 用法：node tools/static-build/build.mjs <输出目录> [依赖 node_modules 目录]
// 依赖：marked、highlight.js、katex（任意 node_modules 中可用即可）。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = path.join(ROOT, 'docs');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'build-static'));
const NM = path.resolve(process.argv[3] || path.join(ROOT, 'node_modules'));
const require = createRequire(path.join(NM, 'noop.js'));
const { Marked } = await import(pathToFileURL(path.join(NM, 'marked/lib/marked.esm.js')).href);
const hljs = require('highlight.js');
const katex = require('katex');
const { makeDocsPreprocessor } = await import(pathToFileURL(path.join(ROOT, 'scripts/lib/preprocess.mjs')).href);
const preprocess = makeDocsPreprocessor({ docsDir: DOCS });
const menu = JSON.parse(fs.readFileSync(path.join(DOCS, 'menu-config.json'), 'utf8'));
const TPL = path.join(ROOT, 'tools/static-build');
const ORIGIN = 'https://llm-d.ai';
const warnings = [];
const docAssets = new Map();

// ---------- 收集文档 ----------
const docs = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'assets' && e.name !== 'images') walk(p); continue; }
    if (/\.mdx?$/.test(e.name)) docs.push(p);
  }
})(DOCS);

function splitFM(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  if (!m) return [{}, src];
  const fm = {};
  for (const l of m[1].split('\n')) {
    const kv = l.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return [fm, src.slice(m[0].length)];
}

const pages = docs.map((file) => {
  const rel = path.relative(DOCS, file).split(path.sep).join('/');
  const id = rel.replace(/\.mdx?$/, '');
  const raw = fs.readFileSync(file, 'utf8');
  const [fm] = splitFM(raw);
  const isIndex = /(^|\/)(README|index)$/.test(id);
  const dirId = isIndex ? id.replace(/\/?(README|index)$/, '') : null;
  let route = '/docs/' + (isIndex ? dirId : id);
  if (fm.slug === '/') route = '/docs';
  route = route.replace(/\/+$/, '') || '/docs';
  const h1 = raw.match(/^#\s+(.+)$/m);
  const title = fm.title || (h1 ? h1[1].replace(/\s*\{#[^}]+\}\s*$/, '').replace(/`/g, '') : id);
  return { file, rel, id, fm, isIndex, dirId, route, title };
});
const byRoute = new Map(pages.map((p) => [p.route, p]));
const byRel = new Map(pages.map((p) => [p.rel, p]));
const outFile = (route) => (route === '/docs' ? 'index.html' : route.slice(1) + '.html');
for (const p of pages) p.out = outFile(p.route);

// ---------- 侧边栏 ----------
function sortItems(items) {
  return items.sort((a, b) => {
    const pa = a.pos ?? Infinity, pb = b.pos ?? Infinity;
    return pa !== pb ? pa - pb : a.key.localeCompare(b.key);
  });
}
function buildTree(dir) {
  const items = [];
  const abs = path.join(DOCS, dir);
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const relPath = (dir ? dir + '/' : '') + e.name;
    if (e.isDirectory()) {
      if (e.name === 'assets' || e.name === 'images') continue;
      const children = buildTree(relPath);
      const index = pages.find((p) => p.isIndex && p.dirId === relPath);
      if (!children.length && !index) continue;
      const cfg = menu.categories[relPath] || {};
      items.push({ type: 'cat', key: e.name, pos: cfg.position, label: cfg.label || index?.title || e.name,
        page: index, collapsed: cfg.collapsed !== false, children });
    } else if (/\.mdx?$/.test(e.name)) {
      const p = byRel.get(relPath);
      if (!p || p.isIndex) continue;
      const cfg = menu.pages[p.id] || {};
      items.push({ type: 'doc', key: e.name, pos: cfg.position ?? (p.fm.sidebar_position ? +p.fm.sidebar_position : undefined),
        label: cfg.label || p.fm.sidebar_label || p.title, page: p });
    }
  }
  return sortItems(items);
}
const tree = buildTree('');
const order = [];
(function flat(items) { for (const it of items) { if (it.page) order.push(it.page); if (it.children) flat(it.children); } })(tree);
for (const p of pages) if (!order.includes(p)) { warnings.push('未进入侧边栏：' + p.rel); order.push(p); }

// ---------- 链接解析 ----------
function findDoc(target) {
  const t = target.replace(/\/+$/, '');
  const cands = /\.mdx?$/.test(t) ? [t, t + 'x'] : [t + '.md', t + '.mdx', t + '/README.md', t + '/README.mdx', t + '/index.md', t + '/index.mdx'];
  for (const c of cands) if (byRel.has(c)) return byRel.get(c);
  return null;
}
function copyAsset(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (/\.svg$/i.test(src)) fs.writeFileSync(dest, fs.readFileSync(src, 'utf8').replace(/<!DOCTYPE[^>\[]*(\[[\s\S]*?\])?\s*>/gi, ''));
  else fs.copyFileSync(src, dest);
}
function relUrl(fromOut, toOut) {
  const r = path.posix.relative(path.posix.dirname(fromOut), toOut);
  return r || path.posix.basename(toOut);
}
function resolveHref(href, page) {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return href;
  const m = href.match(/^([^#?]*)(\?[^#]*)?(#.*)?$/);
  const p = decodeURI(m[1]); const hash = m[3] || '';
  if (p.startsWith('/')) {
    const route = p.replace(/\/+$/, '').replace(/\.mdx?$/, '');
    if (byRoute.has(route)) return relUrl(page.out, byRoute.get(route).out) + hash;
    if (route.startsWith('/img/')) return relUrl(page.out, route.slice(1));
    warnings.push(`未解析的站内链接 ${href}（${page.rel}）`);
    return ORIGIN + href;
  }
  const fileDir = path.posix.dirname(page.rel);
  let doc = findDoc(path.posix.normalize(path.posix.join(fileDir, p)));
  if (!doc) {
    const routeDir = page.isIndex ? path.posix.dirname(page.route) : path.posix.dirname(page.route);
    const r = path.posix.normalize(path.posix.join(routeDir, p)).replace(/\/+$/, '');
    if (byRoute.has(r)) doc = byRoute.get(r);
  }
  if (doc) return relUrl(page.out, doc.out) + hash;
  const asset = path.posix.normalize(path.posix.join(fileDir, p));
  const assetAbs = path.join(DOCS, asset);
  if (!asset.startsWith('..') && fs.existsSync(assetAbs) && fs.statSync(assetAbs).isFile()) {
    const outRel = 'docs-assets/' + asset;
    docAssets.set(outRel, assetAbs);
    return relUrl(page.out, outRel) + hash;
  }
  warnings.push(`未解析的相对链接 ${href}（${page.rel}）`);
  return href;
}

// ---------- Markdown 预处理 ----------
const ADM = { note: '备注', tip: '提示', info: '信息', warning: '警告', caution: '注意', danger: '危险', important: '重要' };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decodeBraces = (s) => s.replace(/&#123;/g, '{').replace(/&#125;/g, '}');

function prepare(body, isMdx) {
  const lines = body.split('\n');
  const out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i];
    const f = l.match(/^\s*(```+|~~~+)/);
    if (f) {
      if (!fence) fence = f[1];
      else if (l.trim().startsWith(fence) && l.trim().replace(/[`~]/g, '') === '') fence = null;
      out.push(l); continue;
    }
    if (fence) { out.push(l); continue; }
    if (isMdx && /^import\s.+from\s/.test(l)) continue;
    const a = l.match(/^\s*:::\s*([a-z]+)\s*(.*)$/);
    if (a && ADM[a[1]]) {
      const label = a[2].trim() || ADM[a[1]];
      out.push('', `<div class="adm adm-${a[1]}"><div class="adm-title">${esc(label)}</div>`, '');
      continue;
    }
    if (/^\s*:::\s*$/.test(l)) { out.push('', '</div>', ''); continue; }
    const mm = l.match(/^\s*\$\$(.+)\$\$\s*$/);
    if (mm) { out.push('', `<div class="math">${katex.renderToString(decodeBraces(mm[1]), { displayMode: true, output: 'mathml', throwOnError: false })}</div>`, ''); continue; }
    if (isMdx) {
      l = l.replace(/<Link\b([^>]*)>/g, (_, attrs) => '<a' + attrs.replace(/\bclassName=/g, 'class=').replace(/\bto=/g, 'href=') + '>').replace(/<\/Link>/g, '</a>');
    }
    out.push(l);
  }
  return out.join('\n');
}

// ---------- 渲染 ----------
function slugify(text, seen) {
  let s = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-');
  const base = s; let n = seen.get(base) || 0;
  if (n) s = `${base}-${n}`;
  seen.set(base, n + 1);
  return s;
}

function renderPage(page) {
  const raw = fs.readFileSync(page.file, 'utf8');
  const pre = preprocess({ filePath: page.file, fileContent: raw });
  const [, body] = splitFM(pre);
  const md = prepare(body, page.file.endsWith('.mdx'));
  const toc = []; const seen = new Map(); let mermaidCount = 0;
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        let inner = this.parser.parseInline(tokens);
        let id;
        const dm = decodeBraces(inner).match(/\s*\{#([^}]+)\}\s*$/);
        if (dm) { id = dm[1]; inner = decodeBraces(inner).replace(/\s*\{#[^}]+\}\s*$/, ''); seen.set(id, 1); }
        else id = slugify(decodeBraces(text).replace(/\s*\{#[^}]+\}\s*$/, ''), seen);
        if (depth === 2 || depth === 3) toc.push({ depth, id, text: inner.replace(/<[^>]+>/g, '') });
        if (depth === 1) return `<h1>${inner}</h1>\n`;
        return `<h${depth} id="${esc(id)}"><a class="anchor" href="#${esc(id)}" aria-label="本节链接">#</a>${inner}</h${depth}>\n`;
      },
      code({ text, lang }) {
        const language = (lang || '').split(/\s/)[0].toLowerCase();
        if (language === 'mermaid') { mermaidCount++; return `<pre class="mermaid">${esc(text)}</pre>\n`; }
        let html;
        const alias = { sh: 'bash', shell: 'bash', console: 'bash', yml: 'yaml', promql: 'plaintext', text: 'plaintext', txt: 'plaintext' }[language] || language;
        if (alias && hljs.getLanguage(alias)) html = hljs.highlight(text, { language: alias, ignoreIllegals: true }).value;
        else html = esc(text);
        return `<div class="codeblock"><div class="code-head"><span>${esc(language || 'text')}</span><button type="button" class="copy" aria-label="复制代码">复制</button></div><pre><code class="hljs">${html}</code></pre></div>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const h = resolveHref(href, page);
        const ext = /^https?:/i.test(h);
        return `<a href="${esc(h)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>${inner}</a>`;
      },
      image({ href, title, text }) {
        return `<img src="@@R@@${esc(resolveHref(href, page))}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''} loading="lazy">`;
      },
      table(token) {
        return '<div class="table-wrap">' + marked.Renderer.prototype.table.call(this, token) + '</div>\n';
      },
    },
  });
  let html = marked.parse(md);
  // 原始 HTML 中的站内链接与图片
  html = html.replace(/(<(?:img|source)\b[^>]*?\bsrc=")([^"]+)(")/g, (f, a, src, b) => src.startsWith('@@R@@') ? a + src.slice(5) + b : a + esc(resolveHref(src, page)) + b);
  html = html.replace(/(<a\b[^>]*?\bhref=")(\/[^"]*)(")/g, (f, a, href, b) => a + esc(resolveHref(href, page)) + b);
  html = html.replace(/&amp;#(123|125);/g, '&#$1;');
  return { html, toc, mermaid: mermaidCount > 0 };
}

// ---------- 页面模板 ----------
const usedImages = new Set();
function sidebarHtml(items, page, depth = 0) {
  return '<ul class="nav-list">' + items.map((it) => {
    const active = it.page === page;
    const link = it.page ? `<a href="${relUrl(page.out, it.page.out)}"${active ? ' aria-current="page"' : ''}>${esc(it.label)}</a>` : `<span>${esc(it.label)}</span>`;
    if (it.type === 'doc') return `<li class="nav-doc">${link}</li>`;
    const containsActive = (function has(xs) { return xs.some((x) => x.page === page || (x.children && has(x.children))); })(it.children) || active;
    const open = containsActive || !it.collapsed;
    return `<li class="nav-cat"><details${open ? ' open' : ''}><summary>${link}</summary>${sidebarHtml(it.children, page, depth + 1)}</details></li>`;
  }).join('') + '</ul>';
}

function breadcrumbs(page) {
  const trail = [];
  (function find(items, acc) {
    for (const it of items) {
      const next = [...acc, it];
      if (it.page === page) { trail.push(...next); return true; }
      if (it.children && find(it.children, next)) return true;
    }
    return false;
  })(tree, []);
  return trail.slice(0, -1).map((it) => it.page ? `<a href="${relUrl(page.out, it.page.out)}">${esc(it.label)}</a>` : `<span>${esc(it.label)}</span>`).join('<span class="sep">/</span>');
}

const searchIndex = [];
const MERMAID = '<script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>';

function pageHtml(page, r, isMain) {
  const i = order.indexOf(page);
  const prev = order[i - 1], next = order[i + 1];
  const up = (f) => relUrl(page.out, f);
  const enRoute = page.route.replace(/^\/docs/, '/docs');
  const tocHtml = r.toc.length > 1 ? `<nav class="toc" aria-label="本页目录"><div class="toc-title">本页内容</div><ul>${r.toc.map((t) => `<li class="toc-${t.depth}"><a href="#${esc(t.id)}">${esc(t.text)}</a></li>`).join('')}</ul></nav>` : '';
  const head = `<title>${isMain ? 'llm-d 中文文档' : esc(page.title) + ' · llm-d 中文文档'}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;700&display=swap">
<link rel="stylesheet" href="${up('assets/site.css')}">`;
  const bodyHtml = `<a class="skip" href="#main">跳到正文</a>
<header class="topbar">
  <button type="button" class="menu-btn" id="menu-btn" aria-controls="sidebar" aria-expanded="false" aria-label="打开导航">☰</button>
  <a class="brand" href="${up('index.html')}"><span class="brand-mark">llm-d</span><span class="brand-sub">中文文档</span></a>
  <span class="ver" title="对应英文文档版本">v0.10</span>
  <div class="search">
    <input type="search" id="search-input" placeholder="搜索文档…" autocomplete="off" aria-label="搜索文档">
    <div class="search-results" id="search-results" hidden></div>
  </div>
  <nav class="top-links">
    <a href="${ORIGIN}${enRoute}" target="_blank" rel="noopener noreferrer">英文原版</a>
    <a href="https://github.com/llm-d/llm-d" target="_blank" rel="noopener noreferrer">GitHub</a>
  </nav>
</header>
<div class="notice">非官方社区翻译 · 依据 Apache 2.0 许可证翻译自 <a href="${ORIGIN}/docs" target="_blank" rel="noopener noreferrer">llm-d.ai/docs</a>，如有出入以英文原版为准</div>
<div class="layout">
  <aside class="sidebar" id="sidebar" aria-label="文档导航">${sidebarHtml(tree, page)}</aside>
  <div class="scrim" id="scrim" hidden></div>
  <main id="main" class="main">
    <article class="doc">
      ${page.route === '/docs' ? '' : `<div class="crumbs">${breadcrumbs(page)}</div>`}
      ${r.html}
      <div class="doc-foot">
        <a class="orig" href="${ORIGIN}${enRoute}" target="_blank" rel="noopener noreferrer">查看本页英文原文 ↗</a>
      </div>
      <nav class="pager" aria-label="上一页/下一页">
        ${prev ? `<a class="prev" href="${up(prev.out)}"><span>上一页</span><b>${esc(prev.title)}</b></a>` : '<span></span>'}
        ${next ? `<a class="next" href="${up(next.out)}"><span>下一页</span><b>${esc(next.title)}</b></a>` : '<span></span>'}
      </nav>
    </article>
    ${tocHtml}
  </main>
</div>
<footer class="footer">
  <p>本站为 <a href="${ORIGIN}/docs" target="_blank" rel="noopener noreferrer">llm-d 官方文档</a>（v0.10）的非官方中文翻译。原文版权归 llm-d a Series of LF Projects, LLC 所有，依据 <a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer">Apache License 2.0</a> 翻译与再分发。llm-d 是云原生计算基金会（CNCF）沙箱项目。</p>
</footer>
<script>window.__ROOT__=${JSON.stringify(path.posix.relative(path.posix.dirname(page.out), '.') || '.')};</script>
<script charset="utf-8" src="${up('assets/search-index.js')}" defer></script>
<script charset="utf-8" src="${up('assets/site.js')}" defer></script>
${r.mermaid ? MERMAID + '<script>window.addEventListener("load",function(){if(window.mermaid){var d=matchMedia("(prefers-color-scheme: dark)").matches&&document.documentElement.dataset.theme!=="light"||document.documentElement.dataset.theme==="dark";mermaid.initialize({startOnLoad:false,theme:d?"dark":"neutral",securityLevel:"strict"});mermaid.run({querySelector:"pre.mermaid:not([data-processed])"});}});</script>' : ''}`;
  if (isMain) return '<meta charset="utf-8">\n' + head + '\n' + bodyHtml;
  return `<!doctype html>\n<html lang="zh-Hans">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head>\n<body>\n${bodyHtml}\n</body>\n</html>\n`;
}

// ---------- 输出 ----------
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets'), { recursive: true });
for (const page of pages) {
  const r = renderPage(page);
  for (const m of r.html.matchAll(/<img\b[^>]*?\bsrc="([^"]+)"/g)) {
    if (/^[a-z]+:/i.test(m[1]) || m[1].includes('docs-assets/')) continue;
    usedImages.add(path.posix.normalize(path.posix.join(path.posix.dirname(page.out), m[1])));
  }
  const text = r.html.replace(/<pre class="mermaid">[\s\S]*?<\/pre>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  searchIndex.push({ t: page.title, u: page.out, h: r.toc.map((x) => [x.text, x.id]), x: text.slice(0, 8000) });
  const dest = path.join(OUT, page.out);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, pageHtml(page, r, page.route === '/docs'));
}
for (const img of usedImages) {
  const src = path.join(ROOT, 'static', img);
  if (!fs.existsSync(src)) { warnings.push('缺少图片：' + img); continue; }
  copyAsset(src, path.join(OUT, img));
}
for (const [outRel, src] of docAssets) {
  copyAsset(src, path.join(OUT, outRel));
}
fs.copyFileSync(path.join(TPL, 'site.css'), path.join(OUT, 'assets/site.css'));
fs.copyFileSync(path.join(TPL, 'site.js'), path.join(OUT, 'assets/site.js'));
fs.writeFileSync(path.join(OUT, 'assets/search-index.js'), 'window.__SEARCH__=' + JSON.stringify(searchIndex) + ';');
console.log(`已生成 ${pages.length} 个页面、${usedImages.size} 张图片 → ${OUT}`);
if (warnings.length) console.log('警告：\n' + [...new Set(warnings)].join('\n'));
