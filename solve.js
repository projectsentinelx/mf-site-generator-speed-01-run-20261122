// A faster drop-in for makefun-site 1.0.0: run(input) returns, for one case's input, the output tree that
// makefun-site 1.0.0's build returns, path by path, byte for byte. Same rules, same answers, less work:
// the HTML escaper takes whole runs at once, Markdown is lexed on character codes, and inline scanning
// jumps between the characters that can start a construct instead of walking every one.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_ANY = /[&<>"']/;
const HTML_ALL = /[&<>"']/g;
const escChar = (c) => ESCAPES[c];

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return HTML_ANY.test(text) ? text.replace(HTML_ALL, escChar) : text;
}

const SLUG_MAX = 64;
const ASCII_ONLY = /^[\u0000-\u007f]*$/;

/** The slug of `text` (README.md, "Text"): NFKD, marks dropped, A-Z lowered, gaps to "-", 64 chars, "untitled". */
export function slugify(text) {
  const plain = ASCII_ONLY.test(text) ? text : text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let k;
    if (c >= 65 && c <= 90) k = String.fromCharCode(c + 32);
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = plain[i];
    else {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += k;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words. */
function longDate(date) {
  const a = date.indexOf('-');
  const b = date.indexOf('-', a + 1);
  const d = Number(date.slice(b + 1));
  const m = Number(date.slice(a + 1, b));
  return `${d} ${MONTHS[m - 1]} ${date.slice(0, a)}`;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: quoted, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let close = -1;
  let closeAt = -1;
  let pos = 4;
  let idx = 1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    if (text.slice(pos, end) === '---') {
      close = idx;
      closeAt = end;
      break;
    }
    idx++;
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  idx = 1;
  while (idx < close) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    pos = end + 1;
    const at0 = idx++;
    const c0 = line.charCodeAt(0);
    if (c0 === 35) continue;
    if (line === '' || c0 === 32 || c0 === 9) {
      let blank = true;
      for (let k = 0; k < line.length; k++) {
        const c = line.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          blank = false;
          break;
        }
      }
      if (blank) continue;
    }
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${at0 + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeAt + 1) };
}

// ---------------------------------------------------------------- markdown, blocks

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence opener's language, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) continue;
    break;
  }
  for (let j = i; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
  }
  return line.slice(3, i);
}

function fenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && isBlank(line.slice(3));
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < 7 && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let i = n;
  while (i < line.length) {
    const d = line.charCodeAt(i);
    if (d === 32 || d === 9) i++;
    else break;
  }
  if (i >= line.length) return null;
  let e = line.length;
  while (e > i) {
    const d = line.charCodeAt(e - 1);
    if (d === 32 || d === 9) e--;
    else break;
  }
  return { depth: n, text: line.slice(i, e) };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  const c2 = line.charCodeAt(2);
  if (!((c0 === 45 && line.charCodeAt(1) === 45 && c2 === 45) || (c0 === 42 && line.charCodeAt(1) === 42 && c2 === 42))) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const CONTINUED = /^ {2,}\S/;

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading) and its excerpt (the first paragraph's HTML, or ""). Blocks are read and written in one pass.
 */
function renderMarkdown(src, env) {
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = fenceOpen(line);
    if (fence !== null) {
      const from = i + 1;
      i++;
      while (i < n && !fenceClose(lines[i])) i++;
      let code = '';
      if (i > from) {
        let joined = lines[from];
        for (let k = from + 1; k < i; k++) joined = `${joined}\n${lines[k]}`;
        code = `${escapeHtml(joined)}\n`;
      }
      i++;
      html += fence === '' ? `<pre><code>${code}</code></pre>\n` : `<pre><code class="language-${escapeHtml(fence)}">${code}</code></pre>\n`;
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const inner = inline(heading.text, env);
      html += `<h${heading.depth} id="${id}">${inner}</h${heading.depth}>\n`;
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: inner });
      i++;
      continue;
    }
    if (isHr(line)) {
      html += '<hr>\n';
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      let text = '';
      let any = false;
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        const t = trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        if (t !== '') {
          text = any ? `${text}\n${t}` : t;
          any = true;
        }
      }
      html += any ? `<blockquote>\n<p>${inline(text, env)}</p>\n</blockquote>\n` : '<blockquote>\n</blockquote>\n';
      continue;
    }
    const c0 = line.charCodeAt(0);
    let isOrdered = false;
    let orderedStart = 1;
    let isItem = (c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32;
    if (!isItem) {
      let d = 0;
      while (d < line.length) {
        const c = line.charCodeAt(d);
        if (c >= 48 && c <= 57) d++;
        else break;
      }
      if (d > 0 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
        isItem = true;
        isOrdered = true;
        orderedStart = Number(line.slice(0, d));
      }
    }
    if (isItem) {
      let items = '';
      while (i < n) {
        const l = lines[i];
        let item = null;
        if (isOrdered) {
          let d = 0;
          while (d < l.length) {
            const c = l.charCodeAt(d);
            if (c >= 48 && c <= 57) d++;
            else break;
          }
          if (d > 0 && d <= 9 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) item = trimLine(l.slice(d + 2));
        } else if ((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l.charCodeAt(1) === 32) {
          item = trimLine(l.slice(2));
        }
        if (item === null) break;
        i++;
        while (i < n && CONTINUED.test(lines[i])) item = `${item}\n${trimLine(lines[i++])}`;
        items += `<li>${inline(item, env)}</li>\n`;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && orderedStart !== 1 ? `<ol start="${orderedStart}">` : `<${tag}>`;
      html += `${open}\n${items}</${tag}>\n`;
      continue;
    }
    let text = trimLine(line);
    i++;
    while (i < n && !endsParagraph(lines[i])) text = `${text}\n${trimLine(lines[i++])}`;
    const inner = inline(text, env);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- markdown, inline

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_RE = /[\\`*[&<>"']/g;
const CLOSE_BRACKET_RE = /\\.|\]/g;
const DOUBLE_STAR_RE = /\\.|\*\*/g;
const STAR_RE = /\\.|\*/g;
const SPACE_RE = /\s/;

/** The first index from `from` where `s` holds `]`, outside an escape, or -1. */
function findBracket(s, from) {
  CLOSE_BRACKET_RE.lastIndex = from;
  for (;;) {
    const m = CLOSE_BRACKET_RE.exec(s);
    if (m === null) return -1;
    if (m[0] === ']') return m.index;
  }
}

/** The first index from `from` where `s` holds `**`, outside an escape, or -1. */
function findDoubleStar(s, from) {
  DOUBLE_STAR_RE.lastIndex = from;
  for (;;) {
    const m = DOUBLE_STAR_RE.exec(s);
    if (m === null) return -1;
    if (m[0] === '**') return m.index;
  }
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  STAR_RE.lastIndex = from;
  for (;;) {
    const m = STAR_RE.exec(s);
    if (m === null) return -1;
    if (m[0] !== '*') continue;
    const j = m.index;
    if (s.charCodeAt(j + 1) === 42) {
      STAR_RE.lastIndex = j + 2;
      continue;
    }
    return j;
  }
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const len = s.length;
  while (i < len) {
    INLINE_RE.lastIndex = i;
    const m = INLINE_RE.exec(s);
    const p = m === null ? len : m.index;
    if (p > i) {
      out += s.slice(i, p);
      i = p;
      if (i >= len) break;
    }
    const c = s[i];
    if (c === '\\') {
      const nx = s[i + 1];
      if (nx !== undefined && ESCAPABLE.has(nx)) {
        out += escapeHtml(nx);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findDoubleStar(s, i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findBracket(s, i + 1);
      const t = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = t === -1 ? '' : s.slice(k + 2, t);
      if (target !== '' && !SPACE_RE.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = t + 1;
      } else {
        out += '[';
        i++;
      }
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let k = lineStart; k < open; k++) {
      const c = src.charCodeAt(k);
      if (c !== 32 && c !== 9) {
        standalone = false;
        break;
      }
    }
    if (standalone) {
      for (let k = end; k < lineEnd; k++) {
        const c = src.charCodeAt(k);
        if (c !== 32 && c !== 9) {
          standalone = false;
          break;
        }
      }
    }
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes. */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !Object.hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) out += (k === 0 ? '' : ', ') + textOf(v[k]);
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered in `scope`. */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const n = nodes[k];
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += ctx.escape(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let j = 0; j < xs.length; j++) {
          const vars = { [n.name]: xs[j], loop: { index: j + 1, first: j === 0, last: j === xs.length - 1, length: xs.length } };
          out += renderNodes(n.body, { vars, parent: scope }, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- templates, compiled

// A template is parsed once, then compiled to a function of (V, F, depth): V the page's values, F the loop bindings
// an including template hands down, depth how deep the includes are. A name is resolved at compile time - to a local
// of the nearest enclosing for, to V, or to F - so rendering reads it once per use instead of walking a scope chain.

const ROOT_KEYS = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag']);
const NO_VARS = Object.freeze({});

/** `v[k]` when `v` is an object holding `k` of its own, else undefined (README.md, Templates). */
const at = (v, k) => (v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined);

/** The names and includes a template's nodes mention, wherever they sit. */
function refsOf(nodes, names, incs) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'include') incs.add(n.name);
    else {
      names.add(n.path[0]);
      if (n.kind === 'for') refsOf(n.body, names, incs);
      else if (n.kind === 'if') {
        refsOf(n.then, names, incs);
        if (n.else !== null) refsOf(n.else, names, incs);
      }
    }
  }
}

let uid = 0;

/** The expression a path reads, in `locals` (name -> local identifier). */
function pathExpr(path, locals) {
  const first = path[0];
  const local = locals.get(first);
  let e = local !== undefined ? local : ROOT_KEYS.has(first) ? `V.${first}` : `at(F,${JSON.stringify(first)})`;
  for (let k = 1; k < path.length; k++) e = `at(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** The statements that append `nodes` rendered in `locals` to `out`. */
function compileNodes(nodes, locals, freeOf) {
  let src = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        src += `out+=${JSON.stringify(n.text)};`;
        break;
      case 'var':
        src += `out+=esc(textOf(${pathExpr(n.path, locals)}));`;
        break;
      case 'raw':
        src += `out+=textOf(${pathExpr(n.path, locals)});`;
        break;
      case 'if': {
        src += `if(truthy(${pathExpr(n.path, locals)})!==${n.not}){${compileNodes(n.then, locals, freeOf)}}`;
        if (n.else !== null) src += `else{${compileNodes(n.else, locals, freeOf)}}`;
        break;
      }
      case 'for': {
        const a = `$$a${++uid}`;
        const i = `$$i${++uid}`;
        const inner = new Map(locals);
        if (n.name !== 'loop') {
          const el = `$$l${++uid}`;
          inner.set(n.name, el);
          src += `{const ${a}=${pathExpr(n.path, locals)};if(Array.isArray(${a})){for(let ${i}=0;${i}<${a}.length;${i}++){const ${el}=${a}[${i}];const $$lp${uid}={index:${i}+1,first:${i}===0,last:${i}===${a}.length-1,length:${a}.length};`;
          inner.set('loop', `$$lp${uid}`);
        } else {
          src += `{const ${a}=${pathExpr(n.path, locals)};if(Array.isArray(${a})){for(let ${i}=0;${i}<${a}.length;${i}++){const $$lp${uid}={index:${i}+1,first:${i}===0,last:${i}===${a}.length-1,length:${a}.length};`;
          inner.set('loop', `$$lp${uid}`);
        }
        src += `${compileNodes(n.body, inner, freeOf)}}}}`;
        break;
      }
      case 'include': {
        const free = freeOf.get(n.name);
        const parts = [];
        if (free !== undefined) {
          for (const name of free) {
            if (ROOT_KEYS.has(name)) continue;
            const local = locals.get(name);
            parts.push(`${JSON.stringify(name)}:${local !== undefined ? local : `at(F,${JSON.stringify(name)})`}`);
          }
        }
        const t = `$$t${++uid}`;
        src += `{const ${t}=T[${JSON.stringify(n.name)}];if(${t}!==undefined&&depth<8)out+=${t}(V,${parts.length === 0 ? 'NO_VARS' : `{${parts.join(',')}}`},depth+1);}`;
        break;
      }
    }
  }
  return src;
}

/** Each template compiled to (V, F, depth) -> text; a template that does not compile keeps the tree walker. */
function compileTemplates(templates) {
  const own = new Map();
  const incs = new Map();
  for (const [name, nodes] of templates) {
    const names = new Set();
    const inc = new Set();
    refsOf(nodes, names, inc);
    own.set(name, names);
    incs.set(name, inc);
  }
  // the names a template (and everything it includes) may read from the caller's loop bindings
  const freeOf = new Map();
  const walk = (name, seen) => {
    const done = freeOf.get(name);
    if (done !== undefined) return done;
    if (seen.has(name)) return new Set();
    seen.add(name);
    const out = new Set();
    for (const n of own.get(name) ?? []) if (!ROOT_KEYS.has(n)) out.add(n);
    for (const inner of incs.get(name) ?? []) for (const n of walk(inner, seen)) out.add(n);
    seen.delete(name);
    freeOf.set(name, out);
    return out;
  };
  for (const name of templates.keys()) walk(name, new Set());

  // every template compiled by one Function, so the engine parses one script instead of one a template
  let src = 'const T=Object.create(null);';
  const bodies = [];
  for (const [name, nodes] of templates) {
    let body = null;
    try {
      uid = 0;
      body = compileNodes(nodes, new Map(), freeOf);
    } catch (err) {
      body = null;
    }
    bodies.push([name, nodes, body]);
    if (body !== null) src += `T[${JSON.stringify(name)}]=function(V,F,depth){let out="";${body}return out;};`;
  }
  const compiled = new Function('esc', 'at', 'textOf', 'truthy', 'NO_VARS', `${src}return T;`)(escapeHtml, at, textOf, truthy, NO_VARS);
  for (const [name, nodes, body] of bodies) {
    if (body === null) compiled[name] = (V, F, depth) => renderNodes(nodes, { vars: { ...V, ...F }, parent: null }, { templates, escape: escapeHtml }, depth);
  }
  return compiled;
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Which code units JavaScript's \s names: a word ends at one. */
const SPACE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) SPACE[c] = 1;
for (let c = 8192; c <= 8202; c++) SPACE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (SPACE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dirParts`, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  let i = 0;
  while (i <= rel.length) {
    const j = rel.indexOf('/', i);
    const seg = j === -1 ? rel.slice(i) : rel.slice(i, j);
    i = j === -1 ? rel.length + 1 : j + 1;
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's (or page's) card. */
function cardOf(s) {
  const tags = [];
  for (const t of s.tagRefs) tags.push({ name: t.name, slug: t.slug, url: t.url });
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    // Counted when a layout reads it, then kept: most pages show no date and so never read it.
    get reading_minutes() {
      const v = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
      Object.defineProperty(this, 'reading_minutes', { value: v, writable: true, enumerable: true, configurable: true });
      return v;
    },
    tags,
  };
}

/** A page as its layout reads it: a post's own card, filled in, or a page's own. */
function pageOf(s, card) {
  const p = card ?? cardOf(s);
  p.slug = s.slug;
  p.content = s.html;
  p.toc = s.toc;
  p.newer = linkOf(s.newer ?? null);
  p.older = linkOf(s.older ?? null);
  p.is_post = s.post;
  return p;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const site = input.site;
  const base = site.base_url.replace(/\/+$/, '');

  // templates, in code-unit order of their names; one that does not parse is reported and left out
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. sources, sorted by path; .md is a source (line ends "\n"), anything else static
  const sources = [];
  const statics = [];
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. permalinks: each page's output directory and url, slugs unique in their directory
  const slugCache = new Map();
  const slugOf = (text) => {
    let v = slugCache.get(text);
    if (v === undefined) {
      v = slugify(text);
      slugCache.set(text, v);
    }
    return v;
  };
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown, links resolved
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of kept) {
    const dirPath = dirOf(s.path);
    const dirParts = dirPath === '' ? [] : dirPath.split('/');
    const src = s;
    const env = {
      link(target) {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null) {
          const p = bySource.get(path);
          if (p !== undefined) return `${p.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${src.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections: the posts, newest first, then by slug
  const posts = [];
  for (const s of kept) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. tags: grouped by slug, named first met in the posts' order, ordered by count then slug
  const bySlug = new Map();
  const ownTags = (s) => {
    const ts = s.data.tags;
    if (ts === undefined) return [];
    const seen = new Set();
    const out = [];
    for (const name of ts) {
      const slug = slugOf(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = [];
    for (const { name, slug } of ownTags(s)) {
      const tag = bySlug.get(slug);
      s.tagRefs.push(tag === undefined ? { name, slug, url: '', posts: [] } : tag);
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const siteVars = { title: site.title, base_url: base };
  const allTags = [];
  for (const t of tags) allTags.push({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length });
  const recent = [];
  for (const p of posts.slice(0, site.recent)) recent.push(cards.get(p));
  const renderers = compileTemplates(templates);
  const render = (name, vars) => {
    const fn = renderers[name];
    if (fn === undefined) return null;
    return fn({ site: siteVars, tags: allTags, recent, ...vars }, NO_VARS, 0);
  };

  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, cards.get(s)) });

  const per = site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const list = [];
    for (const p of posts.slice((k - 1) * per, k * per)) list.push(cards.get(p));
    const html = render('index', {
      posts: list,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }

  for (const t of tags) {
    const list = [];
    for (const p of t.posts) list.push(cards.get(p));
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: list } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }

  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. the report
  const lines = [...report, ...broken].sort(byCodeUnits);
  let nPages = 0;
  for (const s of kept) if (!s.post) nPages++;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
