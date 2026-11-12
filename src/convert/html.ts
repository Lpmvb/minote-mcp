/**
 * Parser + writer for Xiaomi Notes' body format.
 *
 * A note body is a newline-separated stream of blocks. The format below is
 * verified against live data AND against the serializer/deserializer in the
 * i.mi.com h5 bundle (`mcfe--micloud-web-note/static/js/main.*.chunk.js`):
 *
 *   <new-format/>                                   optional forward-compat marker
 *   <text indent="1">…</text>                        paragraph (indent = depth)
 *   <text indent="1"><size>…</size></text>           h1
 *   <text indent="1"><mid-size>…</mid-size></text>   h2
 *   <text indent="1"><h3-size>…</h3-size></text>     h3
 *   <text indent="1"><center>…</center></text>       centered
 *   <text indent="1"><right>…</right></text>         right-aligned
 *   <bullet indent="1" />content                     bullet item  (marker + content)
 *   <order indent="1" inputnumber="1" />content      ordered item (marker + content)
 *   <input type="checkbox" indent="1" [checked="true"] />content   checklist item
 *   <h1 />content                                    heading (marker + content)
 *   <quote>content</quote>                           blockquote
 *   <hr />                                           horizontal rule
 *   <img fileid="…" imgshow="0" imgdes="…" />        image
 *   <sound fileid="…" />                             voice note
 *   <a href="…">title</a>                            link block
 *   <ul>…</ul> <ol>…</ol> <li>…</li>                 legacy list wrappers
 *
 * Inline runs: <b> <i> <u> <delete> <background color="#rrggbbaa">
 * Legacy bodies with no tags at all are treated as one paragraph per line.
 *
 * Note on markers: the writer emits `<name … />` + content for bullets, ordered
 * items, checklists and headings, because that is exactly what the app's own
 * serializer produces (`i("bullet",{indent})+o`). The reader accepts BOTH the
 * marker form and a wrapping `<name …>content</name>` form.
 */

export type NoteBlock =
  | { kind: 'text'; indent: number; html: string; align?: 'center' | 'right' }
  | { kind: 'heading'; level: 1 | 2 | 3; html: string }
  | { kind: 'bullet'; indent: number; html: string }
  | { kind: 'order'; indent: number; number: string; html: string }
  | { kind: 'todo'; indent: number; checked: boolean; html: string }
  | { kind: 'quote'; html: string }
  | { kind: 'hr' }
  | { kind: 'image'; fileId: string; description: string }
  | { kind: 'sound'; fileId: string }
  | { kind: 'link'; href: string; title: string };

export interface ParsedNote {
  /** True when the body carried a <new-format/> marker or used a modern-only tag. */
  modern: boolean;
  blocks: NoteBlock[];
}

// ---------------------------------------------------------------------------
// Tag scanning
// ---------------------------------------------------------------------------

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'new-format', 'sound']);

const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)\s*>/g;

interface Tag {
  name: string;
  attrs: Record<string, string>;
  selfClosing: boolean;
  close: boolean;
  start: number;
  end: number;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = (m[1] ?? '').toLowerCase();
    if (!name) continue;
    attrs[name] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

function scanTags(input: string): Tag[] {
  const tags: Tag[] = [];
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(input)) !== null) {
    const name = (m[2] ?? '').toLowerCase();
    tags.push({
      name,
      attrs: parseAttrs(m[3] ?? ''),
      selfClosing: m[4] === '/' || VOID_TAGS.has(name),
      close: m[1] === '/',
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tags;
}

function safeChar(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

export function decodeEntities(input: string): string {
  const map: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ensp: ' ',
    emsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    ldquo: '“',
    rdquo: '”',
    lsquo: '‘',
    rsquo: '’',
    middot: '·',
  };
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeChar(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeChar(code) : whole;
    }
    return map[body.toLowerCase()] ?? whole;
  });
}

/**
 * Pull one block off the head of a line.
 *
 * Handles both shapes the format tolerates:
 *   `<name attrs>content</name>`   (wrapping)
 *   `<name attrs />content`        (marker + rest)  ← what the app writes
 *
 * Returns undefined when the line doesn't start with `<name`.
 */
function takeBlock(
  line: string,
  name: string,
): { attrs: Record<string, string>; content: string; consumed: number } | undefined {
  const head = new RegExp(`^<${name}(\\s[^>]*?)?(\\/?)>`, 'i').exec(line);
  if (!head) return undefined;

  const attrs = parseAttrs(head[1] ?? '');
  const rest = line.slice(head[0].length);

  // Wrapping form: content ends at the matching close tag.
  const closeTag = `</${name}>`;
  if (!head[2] && rest.toLowerCase().endsWith(closeTag)) {
    return { attrs, content: rest.slice(0, rest.length - closeTag.length), consumed: line.length };
  }

  // Marker form: everything after the marker is the content.
  return { attrs, content: rest, consumed: line.length };
}

function indentOf(attrs: Record<string, string>): number {
  const n = Number.parseInt(attrs['indent'] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

/** Markers that force the `<new-format/>` prefix when written. */
const MODERN_ONLY = new Set(['h3-size', 'hr', 'quote']);

export function parseNoteContent(content: string): ParsedNote {
  const blocks: NoteBlock[] = [];
  if (!content || !content.trim()) return { modern: false, blocks };

  let modern = false;
  const lines = content
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const rawLine of lines) {
    // <new-format/> is a marker inside the body, not necessarily alone on its
    // line — the app writes `<new-format/>` immediately followed by the first
    // block. Strip it wherever it appears at the head of a line.
    let line = rawLine;
    const marker = /^<new-format\s*\/?>/i.exec(line);
    if (marker) {
      modern = true;
      line = line.slice(marker[0].length).trim();
      if (!line) continue;
    }

    // ---- image / sound / hr (void, whole line)
    if (/^<(img|sound|hr)\b/i.test(line)) {
      const tag = /^<(img|sound|hr)\b([^>]*?)\/?>/i.exec(line);
      if (tag) {
        const name = (tag[1] ?? '').toLowerCase();
        const a = parseAttrs(tag[2] ?? '');
        modern = true;
        if (name === 'img') {
          blocks.push({ kind: 'image', fileId: a['fileid'] ?? '', description: decodeEntities(a['imgdes'] ?? '') });
        } else if (name === 'sound') {
          blocks.push({ kind: 'sound', fileId: a['fileid'] ?? '' });
        } else {
          blocks.push({ kind: 'hr' });
        }
        continue;
      }
    }

    // ---- blockquote
    const quote = takeBlock(line, 'quote');
    if (quote) {
      modern = true;
      blocks.push({ kind: 'quote', html: quote.content });
      continue;
    }

    // ---- link block
    const link = takeBlock(line, 'a');
    if (link) {
      modern = true;
      blocks.push({
        kind: 'link',
        href: decodeEntities(link.attrs['href'] ?? ''),
        title: decodeEntities(link.content.replace(/<[^>]+>/g, '')),
      });
      continue;
    }

    // ---- checklist (input marker + content)
    const todo = takeBlock(line, 'input');
    if (todo && (todo.attrs['type'] ?? '').toLowerCase() === 'checkbox') {
      modern = true;
      blocks.push({
        kind: 'todo',
        indent: indentOf(todo.attrs),
        checked: (todo.attrs['checked'] ?? '').toLowerCase() === 'true',
        html: todo.content,
      });
      continue;
    }

    // ---- bullet / ordered markers
    const bullet = takeBlock(line, 'bullet');
    if (bullet) {
      modern = true;
      blocks.push({ kind: 'bullet', indent: indentOf(bullet.attrs), html: bullet.content });
      continue;
    }

    const order = takeBlock(line, 'order');
    if (order) {
      modern = true;
      blocks.push({
        kind: 'order',
        indent: indentOf(order.attrs),
        number: order.attrs['inputnumber'] ?? '1',
        html: order.content,
      });
      continue;
    }

    // ---- text paragraph
    const text = takeBlock(line, 'text');
    if (text) {
      modern = true;
      blocks.push(classifyText(text.content, indentOf(text.attrs)));
      continue;
    }

    // ---- heading markers emitted bare: <h1 />content
    let headingDone = false;
    for (const level of [1, 2, 3] as const) {
      const h = takeBlock(line, `h${level}`);
      if (h) {
        modern = true;
        blocks.push({ kind: 'heading', level, html: h.content });
        headingDone = true;
        break;
      }
    }
    if (headingDone) continue;

    // ---- legacy list wrappers
    const li = takeBlock(line, 'li');
    if (li) {
      blocks.push({ kind: 'bullet', indent: 1, html: li.content });
      continue;
    }
    const ul = takeBlock(line, 'ul');
    if (ul) {
      blocks.push({ kind: 'text', indent: 1, html: ul.content });
      continue;
    }
    const ol = takeBlock(line, 'ol');
    if (ol) {
      blocks.push({ kind: 'text', indent: 1, html: ol.content });
      continue;
    }

    // ---- plain text line (legacy body, or a line the app wrote raw)
    blocks.push({ kind: 'text', indent: 1, html: line });
  }

  return { modern, blocks };
}

function classifyText(inner: string, indent: number): NoteBlock {
  const size = /^<size>([\s\S]*)<\/size>$/i.exec(inner);
  if (size) return { kind: 'heading', level: 1, html: size[1] ?? '' };

  const mid = /^<mid-size>([\s\S]*)<\/mid-size>$/i.exec(inner);
  if (mid) return { kind: 'heading', level: 2, html: mid[1] ?? '' };

  const h3 = /^<h3-size>([\s\S]*)<\/h3-size>$/i.exec(inner);
  if (h3) return { kind: 'heading', level: 3, html: h3[1] ?? '' };

  const center = /^<center>([\s\S]*)<\/center>$/i.exec(inner);
  if (center) return { kind: 'text', indent, html: center[1] ?? '', align: 'center' };

  const right = /^<right>([\s\S]*)<\/right>$/i.exec(inner);
  if (right) return { kind: 'text', indent, html: right[1] ?? '', align: 'right' };

  return { kind: 'text', indent, html: inner };
}

export { MODERN_ONLY };

// ---------------------------------------------------------------------------
// Inline runs -> Markdown
// ---------------------------------------------------------------------------

const INLINE_OPEN: Record<string, string> = {
  b: '**',
  strong: '**',
  i: '*',
  em: '*',
  u: '<u>',
  delete: '~~',
  del: '~~',
  s: '~~',
};

const INLINE_CLOSE: Record<string, string> = {
  b: '**',
  strong: '**',
  i: '*',
  em: '*',
  u: '</u>',
  delete: '~~',
  del: '~~',
  s: '~~',
};

export function inlineToMarkdown(html: string): string {
  let out = '';
  const stack: string[] = [];
  let cursor = 0;

  for (const tag of scanTags(html)) {
    if (tag.start > cursor) out += decodeEntities(html.slice(cursor, tag.start));

    if (tag.close) {
      const idx = stack.lastIndexOf(tag.name);
      if (idx !== -1) {
        for (let i = stack.length - 1; i >= idx; i--) out += INLINE_CLOSE[stack[i] ?? ''] ?? '';
        stack.length = idx;
      }
    } else if (tag.selfClosing) {
      if (tag.name === 'br') out += '\n';
    } else {
      out += INLINE_OPEN[tag.name] ?? '';
      stack.push(tag.name);
    }

    cursor = tag.end;
  }

  if (cursor < html.length) out += decodeEntities(html.slice(cursor));
  return out;
}

/** Plain text with all markup removed — used for snippets and search. */
export function inlineToPlain(html: string): string {
  return inlineToMarkdown(html)
    .replace(/<\/?u>/g, '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/~~/g, '')
    .replace(/\u00a0/g, ' ')
    .trim();
}
