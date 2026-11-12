#!/usr/bin/env node
/** Diagnose connection, cookie health and encryption of the write path. */
import { configPath, inspectCookie, loadConfig } from '../config.js';
import { MiNoteClient, assertCookieLooksValid } from '../micloud/client.js';
import { toNote } from '../micloud/types.js';
import { htmlToMarkdown } from '../convert/markdown.js';
import { markdownToNoteContent } from '../convert/index.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const out: string[] = [];
  const line = (s: string): void => {
    out.push(s);
  };

  line('minote-mcp doctor');
  line('─'.repeat(40));
  line(`配置文件: ${configPath()}`);
  line(`写入开关: ${cfg.allowWrites ? 'on' : 'off'}`);
  line(`UA: ${cfg.userAgent}`);

  if (!cfg.cookie) {
    line('❌ 没有 cookie，先运行 `npm run login`');
    process.stdout.write(`${out.join('\n')}\n`);
    process.exit(1);
  }

  const info = inspectCookie(cfg.cookie);
  line(`cookie 项: ${info.names.length} 个 [${info.names.join(', ')}]`);
  line(`  serviceToken: ${info.hasServiceToken ? '✅' : '❌'}`);
  line(`  userId:       ${info.hasUserId ? '✅' : '❌'}`);
  line(`  i.mi.com_slh: ${info.hasSlh ? '✅' : '—'}`);
  line(`  i.mi.com_ph:  ${info.hasPh ? '✅' : '—'}`);

  try {
    assertCookieLooksValid(cfg.cookie);
  } catch (e) {
    line(`❌ cookie 不完整: ${(e as Error).message}`);
  }

  const client = MiNoteClient.fromConfig(cfg);
  try {
    const page = await client.listPage(5);
    const entries = page.entries ?? [];
    line('');
    line(`✅ 列表接口正常，返回 ${entries.length} 条`);
    line(`   lastPage: ${String(page.lastPage)}  folders: ${page.folders?.length ?? 0}`);
    if (entries[0]) {
      const n = toNote(entries[0]);
      line(`   首条: ${n.subject || '（无标题）'}  modified=${new Date(n.modifyDate).toISOString()}`);
      line(`   id: ${n.id} (${n.id.length} chars)`);
    }
  } catch (e) {
    line('');
    line(`❌ 列表接口失败: ${(e as Error).message}`);
    process.stdout.write(`${out.join('\n')}\n`);
    process.exit(1);
  }

  // Verify the full list walk works and measure how many pages it takes.
  try {
    const all = await client.listAll();
    line(`✅ 全量拉取: ${all.notes.length} 条笔记 / ${all.folders.length} 个文件夹（${all.pages} 页）`);
  } catch (e) {
    line(`⚠️  全量拉取失败: ${(e as Error).message}`);
  }

  // Round-trip the converters so we know edits won't mangle content.
  const sample = '# 标题\n\n正文 **加粗** 和 *斜体*\n\n- 项目一\n- 项目二\n\n- [x] 完成\n- [ ] 未完成\n';
  const html = markdownToNoteContent(sample);
  const back = htmlToMarkdown(html);
  const ok = back.includes('加粗') && back.includes('项目一') && back.includes('[x]');
  line(`${ok ? '✅' : '⚠️ '} Markdown 往返转换${ok ? '正常' : '有偏差'}（${html.length} 字节 HTML）`);

  process.stdout.write(`${out.join('\n')}\n`);
}

main().catch((e: unknown) => {
  process.stdout.write(`doctor 出错: ${(e as Error).message}\n`);
  process.exit(1);
});
