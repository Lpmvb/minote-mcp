#!/usr/bin/env node
/**
 * Export all notes to a Markdown directory (one .md per note + an index).
 * Read-only: never writes back to i.mi.com.
 *
 *   npm run dump -- --out ./notes [--limit 50] [--meta]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../config.js';
import { MiNoteClient } from '../micloud/client.js';
import { htmlToMarkdown, htmlToText } from '../convert/markdown.js';

function parseArgs(argv: string[]): { out: string; limit: number; meta: boolean } {
  let out = './minote-export';
  let limit = Number.POSITIVE_INFINITY;
  let meta = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out' || a === '-o') out = argv[++i] ?? out;
    else if (a === '--limit') limit = Number.parseInt(argv[++i] ?? '', 10) || limit;
    else if (a === '--meta') meta = true;
  }
  return { out, limit, meta };
}

function safeName(input: string): string {
  const cleaned = input
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || 'untitled';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  if (!cfg.cookie) {
    process.stderr.write('没有 cookie，先运行 `npm run login`\n');
    process.exit(1);
  }

  const client = MiNoteClient.fromConfig(cfg);
  const { notes, folders } = await client.listAll();
  const folderName = new Map(folders.map((f) => [f.id, f.subject]));

  const outDir = resolve(args.out);
  mkdirSync(outDir, { recursive: true });

  const sorted = notes.sort((a, b) => b.modifyDate - a.modifyDate).slice(0, args.limit);
  const indexLines: string[] = ['# 小米笔记导出索引', '', `导出时间: ${new Date().toISOString()}`, `注记数: ${sorted.length}`, ''];
  let written = 0;

  for (const [i, note] of sorted.entries()) {
    const full = await client.getNote(note.id);
    const markdown = htmlToMarkdown(full.body ?? '');
    const title = (full.subject || htmlToText(full.snippet ?? '') || '无标题').trim();
    const stamp = new Date(full.createDate || full.modifyDate).toISOString().slice(0, 10);
    const fileName = `${String(i + 1).padStart(4, '0')}-${stamp}-${safeName(title)}.md`;
    const folder = folderName.get(full.folderId) ?? (full.folderId === '0' ? '未分类' : full.folderId);

    const front = args.meta
      ? [
          '---',
          `id: "${full.id}"`,
          `title: "${title.replace(/"/g, '\\"')}"`,
          `folder: "${folder}"`,
          `created: ${new Date(full.createDate).toISOString()}`,
          `modified: ${new Date(full.modifyDate).toISOString()}`,
          '---',
          '',
        ].join('\n')
      : '';

    writeFileSync(join(outDir, fileName), `${front}# ${title}\n\n${markdown}\n`, 'utf8');
    indexLines.push(`- [${title}](${encodeURI(fileName)}) — ${folder} — ${new Date(full.modifyDate).toISOString()}`);
    written++;
    process.stderr.write(`\r导出中 ${written}/${sorted.length}`);
  }

  writeFileSync(join(outDir, 'INDEX.md'), `${indexLines.join('\n')}\n`, 'utf8');
  process.stderr.write(`\n完成：${written} 条笔记 → ${outDir}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`\n导出失败: ${(e as Error).message}\n`);
  process.exit(1);
});
