#!/usr/bin/env node
/**
 * Offline self-test — exercises the note-body <-> Markdown converters and the
 * response normalisers without touching the network.
 *
 *   npm run selftest
 *
 * The fixtures below are copied from real i.mi.com payloads (a travel note and
 * its list metadata), so a regression here means the real reader broke.
 */
import { htmlToMarkdown, htmlToText, snippetOf } from '../convert/markdown.js';
import { markdownToNoteContent, titleFromMarkdown } from '../convert/index.js';
import { parseNoteContent } from '../convert/html.js';
import { lostPrecision, toNote, toFolder, titleOf, type RawNoteMeta } from '../micloud/types.js';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const e = typeof expected === 'string' ? expected : JSON.stringify(expected);
  if (a === e) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}\n`);
  }
}

function checkContains(name: string, haystack: string, needle: string): void {
  if (haystack.includes(needle)) {
    passed++;
    process.stdout.write(`  ok   ${name}\n`);
  } else {
    failed++;
    process.stdout.write(`  FAIL ${name}\n    missing: ${needle}\n    in:      ${haystack}\n`);
  }
}

// -------------------------------------------------- real note body fixtures

/** Trimmed from a real note: headings, plain lines, images, blank line. */
const REAL_BODY = [
  '<text indent="1"><mid-size><background color="#9affe8af">住宿</background></mid-size></text>',
  '<text indent="1"><mid-size><background color="#9affe8af">景点</background></mid-size></text>',
  '<text indent="1">市区</text>',
  '<text indent="1">市博物馆</text>',
  '<text indent="1"></text>',
  '<text indent="1">环湖骑行道（古镇、码头）</text>',
  '<img fileid="123456789.ExampleFileIdAAA" imgshow="0" imgdes="" />',
  '<text indent="1">老城区</text>',
].join('\n');

process.stdout.write('[真实格式解析]\n');

const parsed = parseNoteContent(REAL_BODY);
check('block 数量', parsed.blocks.length, 8);
check('识别为 modern', parsed.modern, true);
check('第一个是标题', parsed.blocks[0]?.kind, 'heading');
check('空 text 保留为空行', parsed.blocks[4]?.kind, 'text');
check('图片块', parsed.blocks[6]?.kind, 'image');

const md = htmlToMarkdown(REAL_BODY);
check(
  '真实笔记转 Markdown',
  md,
  ['## 住宿', '## 景点', '市区', '市博物馆', '', '环湖骑行道（古镇、码头）', '![](note-image://123456789.ExampleFileIdAAA)', '老城区'].join(
    '\n',
  ),
);

check('往返一致', htmlToMarkdown(markdownToNoteContent(md)), md);

process.stdout.write('\n[块类型]\n');
check('bullet 标记形式', htmlToMarkdown('<bullet indent="1" />项目'), '- 项目');
check('bullet 包裹形式', htmlToMarkdown('<bullet indent="1">项目</bullet>'), '- 项目');
check('缩进 2 的 bullet', htmlToMarkdown('<bullet indent="2" />子项'), '- 子项');
check('order 带序号', htmlToMarkdown('<order indent="1" inputnumber="3" />第三'), '3. 第三');
check(
  'todo 已勾选',
  htmlToMarkdown('<input type="checkbox" indent="1" checked="true" />完成'),
  '- [x] 完成',
);
check('todo 未勾选', htmlToMarkdown('<input type="checkbox" indent="1" />未完成'), '- [ ] 未完成');
check('引用', htmlToMarkdown('<quote>一段引用</quote>'), '> 一段引用');
check('分隔线', htmlToMarkdown('<hr />'), '---');
check('链接块', htmlToMarkdown('<a href="https://e.com">站点</a>'), '[站点](https://e.com)');
check('语音', htmlToMarkdown('<sound fileid="357.x" />'), '<audio src="note-audio://357.x"></audio>');
check('h3-size 标题', htmlToMarkdown('<text indent="1"><h3-size>小标</h3-size></text>'), '### 小标');
check('size 标题', htmlToMarkdown('<text indent="1"><size>大标</size></text>'), '# 大标');
check('居中段落', htmlToMarkdown('<text indent="1"><center>居中</center></text>'), '居中');

process.stdout.write('\n[行内样式]\n');
check('加粗', htmlToMarkdown('<text indent="1">前<b>粗</b>后</text>'), '前**粗**后');
check('斜体', htmlToMarkdown('<text indent="1"><i>斜</i></text>'), '*斜*');
check('下划线', htmlToMarkdown('<text indent="1"><u>线</u></text>'), '<u>线</u>');
check('删除线', htmlToMarkdown('<text indent="1"><delete>删</delete></text>'), '~~删~~');
check(
  '嵌套样式',
  htmlToMarkdown('<text indent="1"><b>粗<i>斜</i></b></text>'),
  '**粗*斜***',
);
check('背景色不产生标记', htmlToMarkdown('<text indent="1"><background color="#fff">高亮</background></text>'), '高亮');
check('内联换行', htmlToMarkdown('<text indent="1">上<br/>下</text>'), '上\n下');
check('实体解码', htmlToMarkdown('<text indent="1">a &amp; b &lt;c&gt;</text>'), 'a & b <c>');

process.stdout.write('\n[旧格式与纯文本]\n');
check('无标签纯文本', htmlToMarkdown('第一行\n第二行'), '第一行\n第二行');
check('老 new-format 标记被忽略', htmlToMarkdown('<new-format/><text indent="1">内容</text>'), '内容');
check('空正文', htmlToMarkdown(''), '');
check('只有空白', htmlToMarkdown('   \n  '), '');

process.stdout.write('\n[Markdown -> 笔记格式]\n');
check('标题写出', markdownToNoteContent('# 标题'), '<text indent="1"><size>标题</size></text>');
check('二级标题写出', markdownToNoteContent('## 标题'), '<text indent="1"><mid-size>标题</mid-size></text>');
check(
  'bullet 写出为标记 + 内容',
  markdownToNoteContent('- 项'),
  '<bullet indent="1" />项',
);
check(
  '嵌套 bullet 缩进递增',
  markdownToNoteContent('- 一\n  - 二'),
  '<new-format/><bullet indent="1" />一\n<bullet indent="2" />二',
);
check(
  'todo 写出',
  markdownToNoteContent('- [x] 完'),
  '<input type="checkbox" indent="1" checked="true" />完',
);
check('粗体写出', markdownToNoteContent('**粗**'), '<text indent="1"><b>粗</b></text>');
check('转义 HTML', markdownToNoteContent('a < b'), '<text indent="1">a &lt; b</text>');
check('每行独立成块', markdownToNoteContent('一\n二').split('\n').length, 2);
check(
  '需要时补 new-format 标记',
  markdownToNoteContent('---').startsWith('<new-format/>'),
  true,
);
check('图片写出', markdownToNoteContent('![](note-image://357.a)'), '<img fileid="357.a" imgshow="0" imgdes="" />');

process.stdout.write('\n[往返]\n');
const ROUNDTRIP = [
  '# 标题',
  '',
  '正文 **加粗** 和 *斜体*',
  '',
  '## 二级',
  '',
  '- 项目一',
  '- 项目二',
  '  - 嵌套',
  '',
  '1. 第一步',
  '2. 第二步',
  '',
  '- [x] 完成',
  '- [ ] 未完成',
  '',
  '> 引用',
  '',
  '---',
].join('\n');

const rt = htmlToMarkdown(markdownToNoteContent(ROUNDTRIP));
checkContains('保留一级标题', rt, '# 标题');
checkContains('保留加粗', rt, '**加粗**');
checkContains('保留斜体', rt, '*斜体*');
checkContains('保留二级标题', rt, '## 二级');
checkContains('保留嵌套 bullet', rt, '  - 嵌套');
checkContains('保留有序列表', rt, '1. 第一步');
checkContains('保留勾选', rt, '- [x] 完成');
checkContains('保留引用', rt, '> 引用');
checkContains('保留分隔线', rt, '---');
check('往返完全一致', htmlToMarkdown(markdownToNoteContent(rt)), rt);

process.stdout.write('\n[纯文本与标题]\n');
check('htmlToText 去标记', htmlToText('<text indent="1"><b>粗</b>体</text>'), '粗体');
check('htmlToText 保留图片占位', htmlToText('<img fileid="a" imgdes="" />'), '[图片]');
check('snippetOf 截断', snippetOf('x'.repeat(200), 10), 'xxxxxxxxx…');
check('标题从 Markdown 推导', titleFromMarkdown('# 我的标题\n\n正文'), '我的标题');
check('标题从 todo 推导', titleFromMarkdown('- [ ] 待办'), '待办');
check('标题回退', titleFromMarkdown('', '兜底'), '兜底');

process.stdout.write('\n[元数据归一化]\n');
const raw: RawNoteMeta = {
  // Real payloads quote these — they exceed Number.MAX_SAFE_INTEGER.
  id: '43970664610546496',
  tag: '44065102767735136',
  folderId: '43970660751918752',
  subject: '',
  snippet: '<text indent="1">片段</text>',
  extraInfo: '{"title":"示例标题","note_content_type":"common"}',
  createDate: 1730257822969,
  modifyDate: 1730978357646,
  colorId: 0,
  status: 'normal',
  type: 'note',
};

check('字符串 id 原样保留', toNote(raw).id, '43970664610546496');
check('大整数 tag 不丢精度', toNote(raw).tag, '44065102767735136');
check('安全范围内的数字 id 可接受', toNote({ ...raw, id: 12345 }).id, '12345');
check('检测到精度丢失', lostPrecision(43970664610546500), true);
check('安全整数不误报', lostPrecision(12345), false);
check('标题取自 extraInfo', toNote(raw).subject, '示例标题');
check('folderId 保留字符串', toNote(raw).folderId, '43970660751918752');
check('titleOf 回退到 subject', titleOf({ ...raw, subject: '旧标题', extraInfo: undefined }), '旧标题');
check('titleOf 容忍坏 JSON', titleOf({ ...raw, subject: '', extraInfo: '{oops' }), '');

const folder = toFolder({ id: '43970660751918752', tag: '50090124550096352', folderId: 0, subject: '旅游' });
check('folder id 转字符串', folder.id, '43970660751918752');
check('folder 父级', folder.parentId, '0');
check('folder 名称', folder.subject, '旅游');

process.stdout.write(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
