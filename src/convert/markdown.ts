import { inlineToMarkdown, inlineToPlain, MODERN_ONLY, parseNoteContent, type NoteBlock } from './html.js';

/**
 * Xiaomi note body -> Markdown.
 *
 * The note format treats every element as its own line, and that is how the app
 * reads too — a run of `<text>` lines is a visually continuous column, not a
 * series of paragraphs. So blocks map 1:1 onto lines here: no blank lines are
 * invented between them. Blank lines come only from empty `<text>` elements,
 * which is exactly what the user pressed Enter to create.
 */
export function htmlToMarkdown(content: string): string {
  if (!content || !content.trim()) return '';
  const parsed = parseNoteContent(content);

  const lines: string[] = [];

  for (const block of parsed.blocks) {
    switch (block.kind) {
      case 'text': {
        const md = inlineToMarkdown(block.html);
        // An empty text element is a deliberate blank line.
        lines.push(block.indent > 1 ? `${' '.repeat((block.indent - 1) * 2)}${md}` : md);
        break;
      }
      case 'heading':
        lines.push(`${'#'.repeat(block.level)} ${inlineToMarkdown(block.html).trim()}`);
        break;
      case 'bullet':
        lines.push(`${'  '.repeat(Math.max(0, block.indent - 1))}- ${inlineToMarkdown(block.html).trim()}`);
        break;
      case 'order':
        lines.push(
          `${'  '.repeat(Math.max(0, block.indent - 1))}${block.number}. ${inlineToMarkdown(block.html).trim()}`,
        );
        break;
      case 'todo':
        lines.push(
          `${'  '.repeat(Math.max(0, block.indent - 1))}- [${block.checked ? 'x' : ' '}] ${inlineToMarkdown(block.html).trim()}`,
        );
        break;
      case 'quote':
        lines.push(
          inlineToMarkdown(block.html)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        );
        break;
      case 'hr':
        lines.push('---');
        break;
      case 'image':
        lines.push(
          block.description
            ? `![${block.description}](note-image://${block.fileId})`
            : `![](note-image://${block.fileId})`,
        );
        break;
      case 'sound':
        lines.push(`<audio src="note-audio://${block.fileId}"></audio>`);
        break;
      case 'link':
        lines.push(`[${block.title}](${block.href})`);
        break;
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Cheap plain-text view, used for snippets and search. */
export function htmlToText(content: string): string {
  if (!content || !content.trim()) return '';
  const parsed = parseNoteContent(content);
  const lines: string[] = [];

  for (const block of parsed.blocks) {
    switch (block.kind) {
      case 'text':
      case 'heading':
      case 'quote':
        lines.push(inlineToPlain(block.html));
        break;
      case 'bullet':
      case 'order':
      case 'todo':
        lines.push(inlineToPlain(block.html));
        break;
      case 'link':
        lines.push(block.title);
        break;
      case 'image':
        lines.push(block.description ? `[图片]${block.description}` : '[图片]');
        break;
      case 'sound':
        lines.push('[语音]');
        break;
      case 'hr':
        break;
    }
  }

  return lines
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .trim();
}

export function snippetOf(text: string, length = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

/** Serialize blocks back out — used by the writer and by round-trip tests. */
export function blocksToNoteContent(blocks: NoteBlock[]): string {
  const needsModern = blocks.some(
    (b) =>
      b.kind === 'hr' ||
      b.kind === 'quote' ||
      (b.kind === 'heading' && b.level === 3) ||
      ('indent' in b && b.indent > 1),
  );

  const lines = blocks.map(serializeBlock).filter((l) => l.length > 0);
  const body = lines.join('\n');
  return needsModern ? `<new-format/>${body}` : body;
}

function serializeBlock(block: NoteBlock): string {
  const indentOf = (n: number): string => `indent="${n}"`;

  switch (block.kind) {
    case 'text': {
      const inner =
        block.align === 'center'
          ? `<center>${block.html}</center>`
          : block.align === 'right'
            ? `<right>${block.html}</right>`
            : block.html;
      return `<text ${indentOf(block.indent)}>${inner}</text>`;
    }
    case 'heading': {
      const wrap = block.level === 1 ? 'size' : block.level === 2 ? 'mid-size' : 'h3-size';
      return `<text indent="1"><${wrap}>${block.html}</${wrap}></text>`;
    }
    case 'bullet':
      return `<bullet ${indentOf(block.indent)} />${block.html}`;
    case 'order':
      return `<order ${indentOf(block.indent)} inputnumber="${block.number}" />${block.html}`;
    case 'todo':
      return `<input type="checkbox" ${indentOf(block.indent)}${block.checked ? ' checked="true"' : ''} />${block.html}`;
    case 'quote':
      return `<quote>${block.html}</quote>`;
    case 'hr':
      return '<hr />';
    case 'image':
      return `<img fileid="${block.fileId}" imgshow="0" imgdes="${escapeAttr(block.description)}" />`;
    case 'sound':
      return `<sound fileid="${block.fileId}" />`;
    case 'link':
      return `<a href="${escapeAttr(block.href)}">${escapeText(block.title)}</a>`;
  }
}

function escapeAttr(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { MODERN_ONLY, parseNoteContent };
