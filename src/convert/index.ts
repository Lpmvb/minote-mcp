/**
 * Markdown -> Xiaomi note body.
 *
 * Emits exactly the shape the i.mi.com h5 serializer produces, so notes created
 * here open cleanly in the app and on the phone.
 */
import { blocksToNoteContent } from './markdown.js';
import type { NoteBlock } from './html.js';
import { escapeInline, inlineMarkdownToXml } from './inline.js';

export function markdownToNoteContent(markdown: string): string {
  return blocksToNoteContent(parseMarkdownBlocks(markdown));
}

/** Kept for backwards compatibility with earlier callers/tests. */
export function markdownToHtml(markdown: string): string {
  return markdownToNoteContent(markdown);
}

export function parseMarkdownBlocks(markdown: string): NoteBlock[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: NoteBlock[] = [];
  let i = 0;
  let para: string[] = [];

  // Each markdown source line becomes its own <text> block. That mirrors how the
  // app stores notes (one element per visual line) and keeps round trips stable:
  // joining lines with <br/> inside one block would collapse the line structure
  // the app relies on for per-line indentation and editing.
  const flushPara = (): void => {
    if (para.length === 0) return;
    const source = para;
    para = [];
    for (const line of source) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      blocks.push({ kind: 'text', indent: 1, html: inlineMarkdownToXml(trimmed) });
    }
  };

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code -> one plain paragraph per line, prefixed with a marker so it
    // survives a round trip without being reinterpreted as markdown.
    if (line.trimStart().startsWith('```')) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        body.push(lines[i] ?? '');
        i++;
      }
      i++;
      for (const raw of body) {
        blocks.push({ kind: 'text', indent: 1, html: escapeInline(raw) });
      }
      continue;
    }

    // Horizontal rule
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara();
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      const level = Math.min(3, (heading[1] ?? '#').length) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, html: inlineMarkdownToXml(heading[2] ?? '') });
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) {
        body.push((lines[i] ?? '').replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ kind: 'quote', html: inlineMarkdownToXml(body.join('<br/>')) });
      continue;
    }

    // Checklist
    const check = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (check) {
      flushPara();
      const indent = Math.floor((check[1] ?? '').length / 2) + 1;
      blocks.push({
        kind: 'todo',
        indent,
        checked: (check[2] ?? ' ').toLowerCase() === 'x',
        html: inlineMarkdownToXml(check[3] ?? ''),
      });
      i++;
      continue;
    }

    // Ordered list
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushPara();
      const indent = Math.floor((ordered[1] ?? '').length / 2) + 1;
      blocks.push({
        kind: 'order',
        indent,
        number: ordered[2] ?? '1',
        html: inlineMarkdownToXml(ordered[3] ?? ''),
      });
      i++;
      continue;
    }

    // Bullet list
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const indent = Math.floor((bullet[1] ?? '').length / 2) + 1;
      blocks.push({ kind: 'bullet', indent, html: inlineMarkdownToXml(bullet[2] ?? '') });
      i++;
      continue;
    }

    // Image on its own line
    const img = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (img) {
      flushPara();
      const alt = img[1] ?? '';
      const src = img[2] ?? '';
      if (src.startsWith('note-image://')) {
        blocks.push({ kind: 'image', fileId: src.slice('note-image://'.length), description: alt });
      } else {
        // Foreign image URL: keep it as a link so nothing is silently dropped.
        blocks.push({ kind: 'link', href: src, title: alt || src });
      }
      i++;
      continue;
    }

    // Audio
    const audio = /^\s*<audio\s+src="note-audio:\/\/([^"]+)"><\/audio>\s*$/.exec(line);
    if (audio) {
      flushPara();
      blocks.push({ kind: 'sound', fileId: audio[1] ?? '' });
      i++;
      continue;
    }

    // Blank line: in this format a blank line IS an empty <text> element, which
    // is what the user gets when they press Enter. Preserve it so the spacing
    // they typed survives the round trip. Skip leading blanks.
    if (line.trim() === '') {
      flushPara();
      if (blocks.length > 0) blocks.push({ kind: 'text', indent: 1, html: '' });
      i++;
      continue;
    }

    para.push(line);
    i++;
  }

  flushPara();
  return blocks;
}

/** Derive a note title from markdown — first non-empty line, stripped of markup. */
export function titleFromMarkdown(markdown: string, fallback = ''): string {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const plain = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+(\[[ xX]\]\s+)?/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_~`]/g, '')
      .trim();
    if (plain) return plain.slice(0, 120);
  }
  return fallback;
}

export type { NoteBlock };
