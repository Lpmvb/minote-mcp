#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { MiNoteClient } from './micloud/client.js';
import { NoteStore } from './store.js';
import { registerTools } from './tools/index.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const cfg = loadConfig();

  // Either credential is enough to boot: the service cookie talks to the API
  // directly, and the account cookie can mint a fresh service cookie on demand.
  // Only refuse when we have neither.
  if (!cfg.cookie && !cfg.accountCookie) {
    process.stderr.write(
      [
        '[minote-mcp] 没有找到任何 cookie。',
        '',
        '三种配置方式：',
        '  1) `npm run login`       —— 自动从本机浏览器读取（推荐，macOS）',
        '  2) `npm run login -- --paste` —— 手动粘贴',
        '  3) 环境变量 MINOTE_COOKIE / MINOTE_ACCOUNT_COOKIE',
        '',
        '两个 cookie 只要有一个就能启动：',
        '  MINOTE_COOKIE         i.mi.com 会话，直接调接口用',
        '  MINOTE_ACCOUNT_COOKIE .xiaomi.com 账号会话，能换出新会话',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (!cfg.cookie && cfg.accountCookie) {
    process.stderr.write('[minote-mcp] 只有账号 cookie，首次请求时会先换一个 i.mi.com 会话\n');
  }

  const client = MiNoteClient.fromConfig(cfg, { persist: true });
  const store = new NoteStore(client, { ttlMs: 60_000 });

  const server = new McpServer(
    { name: 'minote', version: VERSION },
    {
      instructions: [
        '这个 server 让 AI 读写用户的小米笔记（i.mi.com）。',
        '写操作默认关闭；若 update_note / create_note 报“写入工具已禁用”，提醒用户开启 allowWrites。',
        '内容统一按 Markdown 处理，内部自动转成小米笔记自己的块格式，用户在手机 App 里看到的排版一致。',
        '改已有笔记前一定要先 get_note 读全文 —— update_note 的 replace 会整体覆盖。',
        '追加内容用 mode=append，不要整篇重写。',
        'delete_note 是破坏性操作，执行前先向用户确认。',
      ].join('\n'),
    },
  );

  registerTools(server, { client, store, allowWrites: cfg.allowWrites });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[minote-mcp] v${VERSION} ready (writes=${cfg.allowWrites ? 'on' : 'off'})\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[minote-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
