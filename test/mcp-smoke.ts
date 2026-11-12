#!/usr/bin/env node
/**
 * End-to-end smoke test over a real MCP stdio connection.
 *
 * Spawns `src/index.ts` as a child process pointed at the mock i.mi.com server,
 * then exercises handshake → tools/list → tools/call for the read and write
 * paths. This is what proves the server actually works inside a real MCP host.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockMicloud } from './mock-micloud.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, '..');

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}\n`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

interface TextResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function textOf(result: unknown): string {
  const r = result as TextResult;
  return (r.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

async function main(): Promise<void> {
  const cookie = 'serviceToken=seed-service-token; userId=12345; i.mi.com_slh=seed-slh; i.mi.com_ph=seed-ph';

  const mock = await startMockMicloud({
    cookie,
    notes: [
      {
        subject: '周会记录',
        content: [
          '<text indent="1"><size>周会记录</size></text>',
          '<text indent="1">讨论了 <b>三个议题</b></text>',
          '<bullet indent="1" />接口对齐',
        ].join('\n'),
        snippet: '<text indent="1">讨论了 三个议题</text>',
      },
      { subject: '买菜清单', content: '<text indent="1">番茄</text>', snippet: '<text indent="1">番茄</text>' },
      { subject: '项目计划', folderId: 501, content: '<text indent="1">Q4</text>', snippet: '<text indent="1">Q4</text>' },
    ],
    folders: [{ id: 501, subject: '工作' }],
  });

  process.stdout.write(`mock on ${mock.url}\n\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(projectRoot, 'src', 'index.ts')],
    env: {
      ...(process.env as Record<string, string>),
      MINOTE_COOKIE: cookie,
      MINOTE_BASE_URL: mock.url,
      MINOTE_ALLOW_WRITES: '1',
      MINOTE_MCP_CONFIG_DIR: join(projectRoot, '.tmp-test-config'),
    },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} });

  try {
    await client.connect(transport);
    process.stdout.write('[握手与工具发现]\n');

    const info = client.getServerVersion();
    eq('server 名称', info?.name, 'minote');

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    const expected = [
      'create_folder',
      'create_note',
      'delete_note',
      'get_note',
      'list_folders',
      'list_notes',
      'note_stats',
      'search_notes',
      'update_note',
    ];
    eq('工具数量', names.length, expected.length);
    ok('工具名齐全', expected.every((n) => names.includes(n)), `got ${names.join(',')}`);

    const listTool = tools.tools.find((t) => t.name === 'list_notes');
    ok('list_notes 有 inputSchema', listTool?.inputSchema?.type === 'object');
    ok('list_notes 有描述', (listTool?.description ?? '').length > 10);

    // ------------------------------------------------------------- reads
    process.stdout.write('\n[读取工具]\n');
    const list = await client.callTool({ name: 'list_notes', arguments: { limit: 10 } });
    const listText = textOf(list);
    ok('list_notes 返回 3 条', listText.includes('共 3 条'), listText);
    ok('list_notes 含标题', listText.includes('周会记录'));
    ok('list_notes 含文件夹名', listText.includes('工作'));

    const filtered = textOf(await client.callTool({ name: 'list_notes', arguments: { folder: '工作' } }));
    ok('按文件夹过滤', filtered.includes('共 1 条') && filtered.includes('项目计划'), filtered);

    const folders = textOf(await client.callTool({ name: 'list_folders', arguments: {} }));
    ok('list_folders 列出来了', folders.includes('工作') && folders.includes('1 条'), folders);

    const stats = textOf(await client.callTool({ name: 'note_stats', arguments: {} }));
    ok('note_stats 总数正确', stats.includes('笔记总数: 3'), stats);

    const search = textOf(await client.callTool({ name: 'search_notes', arguments: { query: '议题' } }));
    ok('搜索标题/摘要命中', search.includes('周会记录'), search);

    const deep = textOf(
      await client.callTool({ name: 'search_notes', arguments: { query: '接口对齐', deep: true } }),
    );
    ok('深度搜索命中正文', deep.includes('周会记录'), deep);

    const miss = textOf(await client.callTool({ name: 'search_notes', arguments: { query: '不存在的词xyz' } }));
    ok('搜不到时给出提示', miss.includes('没有找到'), miss);

    const note = textOf(
      await client.callTool({
        name: 'get_note',
        arguments: { id: mock.notes[0]!.id.toString() },
      }),
    );
    ok('get_note 返回 Markdown 标题', note.includes('# 周会记录'), note.slice(0, 200));
    ok('get_note 带元信息', note.includes('- id:') && note.includes('- 修改:'), note.slice(0, 300));

    // ------------------------------------------------------------ writes
    process.stdout.write('\n[写入工具]\n');
    const createdText = textOf(
      await client.callTool({
        name: 'create_note',
        arguments: { title: '来自 MCP', content: '# 来自 MCP\n\n- 一\n- 二' },
      }),
    );
    ok('create_note 成功', createdText.includes('已创建'), createdText);

    const newNote = mock.notes.find((n) => n.subject === '来自 MCP');
    ok('mock 里确实多了一条', newNote !== undefined);
    ok('笔记体里是 bullet 结构', newNote?.content.includes('<bullet indent="1" />') === true, newNote?.content);

    if (newNote) {
      const upd = textOf(
        await client.callTool({
          name: 'update_note',
          arguments: { id: newNote.id.toString(), mode: 'append', content: '追加的一段' },
        }),
      );
      ok('update_note 成功', upd.includes('已更新'), upd);
      ok('追加写进了正文', newNote.content.includes('追加的一段'), newNote.content);

      const del = textOf(
        await client.callTool({ name: 'delete_note', arguments: { id: newNote.id.toString() } }),
      );
      ok('delete_note 成功', del.includes('回收站'), del);
      eq('mock 里标记为删除', newNote.status, 'deleted');
    }

    const folderText = textOf(await client.callTool({ name: 'create_folder', arguments: { name: '临时' } }));
    ok('create_folder 成功', folderText.includes('已创建文件夹'), folderText);
    ok('mock 里多了文件夹', mock.folders.some((f) => f.subject === '临时'));

    // -------------------------------------------------------- write guard
    process.stdout.write('\n[写入开关]\n');
    await client.close();

    const guarded = new Client({ name: 'smoke-guarded', version: '1.0.0' }, { capabilities: {} });
    const guardedTransport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(projectRoot, 'src', 'index.ts')],
      env: {
        ...(process.env as Record<string, string>),
        MINOTE_COOKIE: cookie,
        MINOTE_BASE_URL: mock.url,
        MINOTE_ALLOW_WRITES: '0',
        MINOTE_MCP_CONFIG_DIR: join(projectRoot, '.tmp-test-config'),
      },
      stderr: 'pipe',
    });
    await guarded.connect(guardedTransport);
    const denied = (await guarded.callTool({
      name: 'create_note',
      arguments: { title: 'x', content: 'y' },
    })) as TextResult & { isError?: boolean };
    const deniedText = textOf(denied);
    ok('关闭写入后 create_note 被拒', /写入工具已禁用/.test(deniedText), deniedText);
    ok('拒绝标记为 isError', denied.isError === true);
    await guarded.close();
  } finally {
    await client.close().catch(() => {});
    await mock.close();
  }

  process.stdout.write(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stdout.write(`\n💥 ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});
