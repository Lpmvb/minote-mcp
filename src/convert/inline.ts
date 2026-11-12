/**
 * Markdown inline -> Xiaomi XML inline runs.
 *
 * The app's own inline vocabulary is small: <b> <i> <u> <delete> <background>.
 * Anything else (tables, strikethrough variants) degrades to plain text rather
 * than being dropped.
 */

export function escapeInline(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Convert `**bold**`, `*italic*`, `~~del~~`, `<u>x</u>`, `[t](u)` into XML. */
export function inlineMarkdownToXml(input: string): string {
  // Work on escaped text so user content can't inject tags, then re-introduce
  // only the formatting we understand.
  let out = escapeInline(input);

  out = out.replace(/`([^`]+)`/g, (_m, code: string) => `<background color="#EEEFF5FF">${code}</background>`);
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, '<b><i>$1</i></b>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  out = out.replace(/__([^_]+)__/g, '<b>$1</b>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<i>$2</i>');
  out = out.replace(/~~([^~]+)~~/g, '<delete>$1</delete>');
  out = out.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g, '<u>$1</u>');

  // Links degrade to "title (href)" — the note format only supports a link
  // *block*, not inline anchors, so this keeps the URL visible instead of
  // pretending it is clickable.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) =>
    label === href ? href : `${label} (${href})`,
  );

  // Hard line break inside a paragraph.
  out = out.replace(/\n/g, '<br/>');

  return out;
}
