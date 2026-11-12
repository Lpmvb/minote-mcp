#!/usr/bin/env node
/**
 * Integration test: drives MiNoteClient + NoteStore against the local mock.
 *
 *   npm run test:integration
 *
 * Covers: pagination, XSRF enforcement, serviceToken enforcement, 401 -> STS
 * refresh, create/update/delete round trips, and HTML<->Markdown fidelity for
 * a realistic Xiaomi note body.
 */
import { MiNoteClient } from '../src/micloud/client.js';
import { NoteStore } from '../src/store.js';
import { htmlToMarkdown } from '../src/convert/markdown.js';
import { markdownToNoteContent, titleFromMarkdown } from '../src/convert/index.js';
import { startMockMicloud } from './mock-micloud.js';

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

async function main(): Promise<void> {
  const cookie = 'serviceToken=seed-service-token; userId=12345; i.mi.com_slh=seed-slh; i.mi.com_ph=seed-ph';
  // Shaped exactly like a real i.mi.com body (see selftest fixtures).
  const longBody = [
    '<text indent="1"><size>周会记录</size></text>',
    '<text indent="1">讨论了 <b>三个议题</b>，结论如下。</text>',
    '<bullet indent="1" />接口对齐',
    '<bullet indent="2" />字段命名统一',
    '<order indent="1" inputnumber="1" />先做灰度',
    '<input type="checkbox" indent="1" checked="true" />写完文档',
    '<input type="checkbox" indent="1" />补齐测试',
    '<quote>下周三之前必须上线</quote>',
    '<a href="https://example.com/spec">规格文档</a>',
  ].join('\n');

  const mock = await startMockMicloud({
    cookie,
    notes: [
      { subject: '周会记录', content: longBody, snippet: '<text indent="1">讨论了 三个议题</text>' },
      { subject: '买菜清单', folderId: 0, content: '<text indent="1">番茄、鸡蛋</text>', snippet: '<text indent="1">番茄、鸡蛋</text>' },
      { subject: '项目计划', folderId: 501, content: '<text indent="1">Q4 目标</text>', snippet: '<text indent="1">Q4 目标</text>' },
    ],
    folders: [{ id: 501, subject: '工作' }],
  });

  process.stdout.write(`mock server on ${mock.url}\n\n`);

  let refreshed: string | null = null;
  const client = new MiNoteClient({
    cookie,
    // A real install has both: the service cookie for API calls and the
    // .xiaomi.com account cookie that makes refresh possible at all.
    accountCookie: 'passToken=seed-pass-token; cUserId=seed-cuser',
    userAgent: 'test-agent',
    baseUrl: mock.url,
    onCookieRefresh: (c) => {
      refreshed = c;
    },
  });

  try {
    // ---------------------------------------------------------- pagination
    process.stdout.write('[分页与列表]\n');
    const page1 = await client.listPage(2);
    eq('第一页 2 条', page1.entries?.length, 2);
    eq('第一页 lastPage=false', page1.lastPage, false);
    ok('第一页带 syncTag', page1.syncTag !== null && page1.syncTag !== undefined);
    eq('文件夹一起返回', page1.folders?.length, 1);

    const all = await client.listAll({ pageSize: 2 });
    eq('全量拉取 3 条', all.notes.length, 3);
    eq('全量拉取 2 页', all.pages, 2);
    eq('文件夹 1 个', all.folders.length, 1);

    // --------------------------------------------------------- GET no XSRF
    const getReq = mock.requests.find((r) => r.method === 'GET' && r.path === '/note/full/page/');
    ok('GET 请求不带 X-XSRF-TOKEN', getReq !== undefined && getReq.xsrf === undefined);

    // ------------------------------------------------------------ store
    process.stdout.write('\n[缓存与正文读取]\n');
    const store = new NoteStore(client, { ttlMs: 0 });
    await store.ensureFresh(true);
    eq('store 里有 3 条', store.allNotes().length, 3);
    eq('文件夹名解析', store.folderName('501'), '工作');
    eq('未分类名称', store.folderName('0'), '（未分类）');

    const target = store.allNotes().find((n) => n.subject === '周会记录');
    ok('找到目标笔记', target !== undefined);
    const { markdown } = await store.getBody(target!.id);
    ok('正文转出标题', markdown.includes('# 周会记录'), markdown);
    ok('正文保留加粗', markdown.includes('**三个议题**'), markdown);
    ok('正文保留嵌套列表', markdown.includes('  - 字段命名统一'), markdown);
    ok('正文保留勾选', markdown.includes('- [x] 写完文档'), markdown);
    ok('正文保留引用', markdown.includes('> 下周三之前必须上线'), markdown);
    ok('正文保留链接', markdown.includes('[规格文档](https://example.com/spec)'), markdown);

    // Bodies are re-fetched on demand: `tag` rotates on every write, so a
    // cached tag would make the next write fail. The trade is one small request
    // per read, which is the right call.
    const before = mock.requests.filter((r) => r.path.startsWith('/note/note/')).length;
    const again = await store.getBody(target!.id);
    const after = mock.requests.filter((r) => r.path.startsWith('/note/note/')).length;
    eq('正文按需重新拉取（保证 tag 新鲜）', after, before + 1);
    eq('二次读取内容一致', again.markdown, markdown);

    // ------------------------------------------------------------- writes
    process.stdout.write('\n[写入路径]\n');
    const created = await client.createNote({
      title: 'MCP 测试',
      body: markdownToNoteContent('# MCP 测试\n\n- 由 AI 创建'),
      colorId: 2,
    });
    ok('创建返回 id', created.id.length > 0, JSON.stringify(created));
    const createReq = mock.requests.find((r) => r.method === 'POST' && r.path === '/note/note');
    eq('POST 带 XSRF', createReq?.xsrf, 'seed-ph');
    ok('POST 带 serviceToken', createReq?.body?.includes('serviceToken=seed-service-token') === true);

    const updated = await client.updateNote({
      id: created.id,
      tag: created.tag,
      title: 'MCP 测试（已改）',
      body: markdownToNoteContent('改过了'),
    });
    eq('更新后标题', updated.subject, 'MCP 测试（已改）');
    eq('更新后正文', updated.body, '<text indent="1">改过了</text>');

    await client.deleteNote(created.id, created.tag, true);
    const second = await client.listAll();
    ok('删除后列表里没有它', second.notes.every((n) => n.id !== created.id));

    // ------------------------------------------------------- XSRF missing
    // The client auto-recovers from a 403 by refreshing the cookie, so the
    // enforcement check has to hit the mock directly.
    process.stdout.write('\n[安全校验]\n');
    const rawNoXsrf = await fetch(`${mock.url}/note/note`, {
      method: 'POST',
      headers: {
        Cookie: 'serviceToken=seed-service-token; userId=1; i.mi.com_ph=seed-ph',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'serviceToken=seed-service-token&entry=%7B%7D',
    });
    eq('mock 对缺 XSRF 的写入返回 403', rawNoXsrf.status, 403);

    const rawNoToken = await fetch(`${mock.url}/note/note`, {
      method: 'POST',
      headers: {
        Cookie: 'serviceToken=seed-service-token; userId=1; i.mi.com_ph=seed-ph',
        'X-XSRF-TOKEN': 'seed-ph',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'entry=%7B%7D',
    });
    eq('mock 对缺 serviceToken 的写入返回 400', rawNoToken.status, 400);

    // A client with a good cookie but no ph must still be able to recover.
    const noPh = new MiNoteClient({
      cookie: 'serviceToken=seed-service-token; userId=1',
      accountCookie: 'passToken=seed-pass-token',
      userAgent: 'test-agent',
      baseUrl: mock.url,
    });
    const recovered = await noPh.createNote({ title: '无 ph 也能写', body: '<text indent="1">x</text>' });
    ok('缺 ph 时通过 STS 刷新恢复写入能力', recovered.id.length > 0);

    // ------------------------------------------------------ 401 -> refresh
    process.stdout.write('\n[登录态刷新]\n');
    mock.expire();
    refreshed = null;
    const page = await client.listPage(1);
    eq('过期后自动刷新并取回数据', page.entries?.length, 1);
    ok('刷新回写了新 cookie', refreshed !== null && refreshed.includes('fresh-service-token'));

    // Without an account cookie a refresh cannot succeed, and must not be tried:
    // the attempt itself clears serviceToken server-side.
    mock.expire();
    const noAccount = new MiNoteClient({
      cookie,
      userAgent: 'test-agent',
      baseUrl: mock.url,
    });
    const beforeCount = mock.requests.length;
    let failed401 = false;
    try {
      await noAccount.listPage(1);
    } catch {
      failed401 = true;
    }
    ok('没有账号 cookie 时直接报错', failed401);
    eq(
      '没有账号 cookie 时不发起续期请求',
      mock.requests.slice(beforeCount).filter((r) => r.path === '/api/user/login').length,
      0,
    );
    mock.unexpire();

    // -------------------------------------------------- md/title helpers
    process.stdout.write('\n[工具函数]\n');
    eq('标题从正文推导', titleFromMarkdown('## 二级\n\n正文'), '二级');
    eq('标题回退值', titleFromMarkdown('', '兜底'), '兜底');
    eq('空 HTML 转 Markdown', htmlToMarkdown(''), '');
  } finally {
    await mock.close();
  }

  process.stdout.write(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  process.stdout.write(`\n💥 ${(e as Error).stack ?? (e as Error).message}\n`);
  process.exit(1);
});
