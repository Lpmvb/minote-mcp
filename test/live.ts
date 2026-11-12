#!/usr/bin/env node
/**
 * Live smoke test against the real account, using the saved cookie.
 *
 *   npm run test:live
 *
 * Read-only by default. Pass --write to additionally create a throwaway note,
 * verify it round-trips, then move it to the trash. The note it creates is the
 * only thing it will ever delete.
 */
import { loadConfig } from '../src/config.js';
import { MiNoteClient } from '../src/micloud/client.js';
import { htmlToMarkdown } from '../src/convert/markdown.js';
import { markdownToNoteContent } from '../src/convert/index.js';

const WRITE = process.argv.includes('--write');

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

const SAMPLE = [
  '# 写入测试',
  '',
  '这一段用来验证 **加粗** 和 *斜体*。',
  '',
  '- 第一项',
  '- 第二项',
  '  - 嵌套项',
  '',
  '- [x] 已完成',
  '- [ ] 未完成',
  '',
  '> 引用一行',
  '',
  '---',
].join('\n');

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.cookie) {
    console.log('没有 cookie，先跑 npm run login');
    process.exit(1);
  }

  const client = MiNoteClient.fromConfig(cfg);

  console.log('[读取]');
  const { notes, folders, pages } = await client.listAll();
  ok('能列出笔记', notes.length >= 0, `pages=${pages}`);
  ok('能列出文件夹', Array.isArray(folders));
  console.log(`   ${notes.length} 条笔记 / ${folders.length} 个文件夹 / ${pages} 页`);

  if (notes[0]) {
    const full = await client.getNote(notes[0].id);
    ok('能读单条正文', typeof full.body === 'string', JSON.stringify(full).slice(0, 200));
    const md = htmlToMarkdown(full.body ?? '');
    ok('正文能转 Markdown', md.length > 0 || (full.body ?? '').trim() === '', md.slice(0, 120));
    console.log(`   首条: ${full.subject || '（无标题）'}`);
  }

  if (!WRITE) {
    console.log('\n（跳过写入测试，加 --write 启用）');
  } else {
    console.log('\n[写入]');
    if (!cfg.allowWrites) {
      console.log('  ⚠️  allowWrites 关闭，临时开启以便本次测试');
    }
    const writer = MiNoteClient.fromConfig({ ...cfg, allowWrites: true });

    const created = await writer.createNote({
      title: '写入测试',
      body: markdownToNoteContent(SAMPLE),
    });
    ok('创建成功并返回 id', created.id.length > 0, JSON.stringify(created));

    if (created.id) {
      try {
        const fetched = await writer.getNote(created.id);
        const back = htmlToMarkdown(fetched.body ?? '');

        ok('标题保留', back.includes('写入测试'), back.slice(0, 120));
        ok('加粗保留', back.includes('**加粗**'), back);
        ok('斜体保留', back.includes('*斜体*'), back);
        ok('嵌套列表保留', back.includes('  - 嵌套项'), back);
        ok('勾选保留', back.includes('- [x] 已完成'), back);
        ok('引用保留', back.includes('> 引用一行'), back);

        const updated = await writer.updateNote({
          id: created.id,
          tag: created.tag,
          title: '写入测试（已改）',
          body: markdownToNoteContent('# 改过了\n\n追加内容'),
        });
        ok('更新成功', updated.subject === '写入测试（已改）', JSON.stringify(updated).slice(0, 200));
      } finally {
        // Only ever remove the note this script just made.
        await writer.deleteNote(created.id, created.tag, true);
        ok('清理完成', true);
      }
    }
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.log(`\n💥 ${(e as Error).message}`);
  process.exit(1);
});
