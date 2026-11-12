import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NoteStore, NoteRecord } from '../store.js';
import type { MiNoteClient } from '../micloud/client.js';
import { htmlToMarkdown, htmlToText, snippetOf } from '../convert/markdown.js';
import { markdownToNoteContent, titleFromMarkdown } from '../convert/index.js';

export interface ToolContext {
  client: MiNoteClient;
  store: NoteStore;
  allowWrites: boolean;
}

function iso(ms: number): string {
  if (!ms) return '';
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

function noteSummary(n: NoteRecord, store: NoteStore): string {
  const folder = store.folderName(n.folderId);
  const bits = [
    `id: ${n.id}`,
    `title: ${n.subject || '（无标题）'}`,
    `folder: ${folder}`,
    `modified: ${iso(n.modifyDate)}`,
  ];
  if (n.snippet) {
    // The API truncates snippets mid-tag, so stray fragments like "<img fileid="
    // can survive parsing. Drop anything that still looks like markup.
    const cleaned = htmlToText(n.snippet).replace(/<[^>]*$/, '').replace(/\s+/g, ' ').trim();
    if (cleaned) bits.push(`snippet: ${snippetOf(cleaned, 120)}`);
  }
  return bits.join('\n');
}

function requireWrites(ctx: ToolContext, action: string): void {
  if (!ctx.allowWrites) {
    throw new Error(
      `写入工具已禁用（${action}）。在配置里设置 allowWrites: true 或环境变量 MINOTE_ALLOW_WRITES=1 后重启 MCP server。`,
    );
  }
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { store } = ctx;

  // ------------------------------------------------------------------ read

  server.registerTool(
    'list_notes',
    {
      title: '列出笔记',
      description:
        '列出小米笔记的笔记（按修改时间倒序）。可按文件夹过滤、分页。返回 id、标题、文件夹、修改时间和摘要。',
      inputSchema: {
        folder: z.string().optional().describe('文件夹名称（模糊匹配）。omit 表示全部'),
        limit: z.number().int().min(1).max(200).default(20).describe('返回条数，默认 20'),
        offset: z.number().int().min(0).default(0).describe('跳过前 N 条'),
        refresh: z.boolean().default(false).describe('强制忽略缓存，重新从服务器拉取'),
      },
    },
    async ({ folder, limit, offset, refresh }) => {
      await store.ensureFresh(refresh);

      let notes = store.sorted();
      if (folder && folder.trim()) {
        const needle = folder.trim().toLowerCase();
        notes = notes.filter((n) => store.folderName(n.folderId).toLowerCase().includes(needle));
      }

      const total = notes.length;
      const page = notes.slice(offset, offset + limit);
      const header = `共 ${total} 条${folder ? `（文件夹包含「${folder}」）` : ''}，返回第 ${offset + 1}-${offset + page.length} 条：`;
      const body = page.map((n) => noteSummary(n, store)).join('\n\n---\n\n');

      return {
        content: [{ type: 'text' as const, text: page.length ? `${header}\n\n${body}` : `${header}\n（空）` }],
      };
    },
  );

  server.registerTool(
    'get_note',
    {
      title: '读取笔记',
      description: '按 id 读取一条笔记的完整内容，正文以 Markdown 返回。',
      inputSchema: {
        id: z.string().describe('笔记 id（list_notes / search_notes 返回的 id）'),
        format: z.enum(['markdown', 'html', 'text']).default('markdown').describe('返回格式'),
      },
    },
    async ({ id, format }) => {
      const { note } = await store.getBody(id);
      let body: string;
      if (format === 'html') body = note.body ?? markdownToNoteContent(note.markdown ?? '');
      else if (format === 'text') body = htmlToText(note.body ?? '');
      else body = note.markdown ?? '';

      const head = [
        `# ${note.subject || '（无标题）'}`,
        `- id: ${note.id}`,
        `- 文件夹: ${store.folderName(note.folderId)}`,
        `- 创建: ${iso(note.createDate)}`,
        `- 修改: ${iso(note.modifyDate)}`,
        '',
        '',
      ].join('\n');

      return { content: [{ type: 'text' as const, text: `${head}${body || '（正文为空）'}` }] };
    },
  );

  server.registerTool(
    'search_notes',
    {
      title: '搜索笔记',
      description:
        '按关键词搜索笔记（标题 + 摘要，deep=true 时连正文一起搜）。空格分隔多个关键词时按 AND 匹配。',
      inputSchema: {
        query: z.string().min(1).describe('关键词，多个用空格分隔'),
        deep: z.boolean().default(false).describe('是否搜索正文（会逐条拉取，稍慢）'),
        limit: z.number().int().min(1).max(100).default(15),
      },
    },
    async ({ query, deep, limit }) => {
      await store.ensureFresh(false);
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      if (terms.length === 0) return { content: [{ type: 'text' as const, text: '请提供至少一个关键词' }] };

      const matches: Array<{ note: NoteRecord; where: string }> = [];

      for (const note of store.sorted()) {
        const title = (note.subject || '').toLowerCase();
        const snippet = htmlToText(note.snippet || '').toLowerCase();
        let haystack = `${title}\n${snippet}`;
        let where = '标题/摘要';

        if (deep && note.markdown !== undefined) {
          haystack += `\n${note.markdown.toLowerCase()}`;
        }

        if (terms.every((t) => haystack.includes(t))) {
          matches.push({ note, where });
          continue;
        }

        if (deep && note.markdown === undefined) {
          // Only fetch bodies when the cheap match failed and deep search is on.
          const { note: fresh, markdown } = await store.getBody(note.id);
          const deepHay = `${fresh.subject}\n${htmlToText(fresh.snippet || '')}\n${markdown}`.toLowerCase();
          if (terms.every((t) => deepHay.includes(t))) matches.push({ note: fresh, where: '正文' });
        }
      }

      if (matches.length === 0) {
        return { content: [{ type: 'text' as const, text: `没有找到包含「${query}」的笔记` }] };
      }

      const shown = matches.slice(0, limit);
      const text = shown
        .map(({ note, where }) => `${noteSummary(note, store)}\n命中: ${where}`)
        .join('\n\n---\n\n');
      const extra = matches.length > shown.length ? `\n\n（还有 ${matches.length - shown.length} 条未显示）` : '';
      return {
        content: [{ type: 'text' as const, text: `找到 ${matches.length} 条：\n\n${text}${extra}` }],
      };
    },
  );

  server.registerTool(
    'list_folders',
    {
      title: '列出文件夹',
      description: '列出所有笔记文件夹及其笔记数量。',
      inputSchema: {},
    },
    async () => {
      await store.ensureFresh(false);
      const counts = new Map<string, number>();
      for (const n of store.allNotes()) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1);

      const lines = store
        .allFolders()
        .sort((a, b) => a.subject.localeCompare(b.subject, 'zh-Hans-CN'))
        .map((f) => `- ${f.subject}  (id: ${f.id}, ${counts.get(f.id) ?? 0} 条)`);
      const uncategorized = counts.get('0') ?? 0;
      if (uncategorized > 0) lines.unshift(`- （未分类）  (id: 0, ${uncategorized} 条)`);

      return {
        content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') : '（还没有文件夹）' }],
      };
    },
  );

  server.registerTool(
    'note_stats',
    {
      title: '笔记统计',
      description: '返回笔记总数、文件夹分布和最近同步状态。',
      inputSchema: { refresh: z.boolean().default(false) },
    },
    async ({ refresh }) => {
      await store.ensureFresh(refresh);
      const notes = store.allNotes();
      const withContent = notes.filter((n) => n.snippet && n.snippet.trim()).length;
      const folders = store.allFolders();
      const latest = store.sorted()[0];
      const text = [
        `笔记总数: ${notes.length}`,
        `有内容: ${withContent}`,
        `文件夹数: ${folders.length}`,
        `最近同步: ${iso(store.syncedAt)}`,
        latest ? `最近修改: ${latest.subject || '（无标题）'} @ ${iso(latest.modifyDate)}` : '最近修改: —',
      ].join('\n');
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // ----------------------------------------------------------------- write

  server.registerTool(
    'create_note',
    {
      title: '新建笔记',
      description: '在小米笔记中新建一条笔记。content 使用 Markdown。',
      inputSchema: {
        title: z.string().optional().describe('标题，省略则取正文第一行'),
        content: z.string().describe('正文，Markdown 格式'),
        folder: z.string().optional().describe('目标文件夹名称（不存在会报错）'),
        color_id: z.number().int().min(0).max(20).default(0).describe('颜色编号，默认 0'),
      },
    },
    async ({ title, content, folder, color_id }) => {
      requireWrites(ctx, 'create_note');

      let folderId = '0';
      if (folder && folder.trim()) {
        await store.ensureFresh(false);
        const found = store.folderByName(folder);
        if (!found) {
          const names = store.allFolders().map((f) => f.subject).join('、') || '（无）';
          throw new Error(`找不到文件夹「${folder}」。现有: ${names}`);
        }
        folderId = found.id;
      }

      const noteTitle = (title ?? titleFromMarkdown(content, '无标题')).trim();
      const body = markdownToNoteContent(content);
      const created = await ctx.client.createNote({
        title: noteTitle,
        body,
        folderId: folderId === '0' ? undefined : folderId,
        colorId: color_id,
      });

      store.invalidate();
      return {
        content: [
          {
            type: 'text' as const,
            text: `已创建笔记「${noteTitle}」${created.id ? `，id: ${created.id}` : '（id 未返回，请用 list_notes 查看）'}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'update_note',
    {
      title: '修改笔记',
      description:
        '修改已有笔记。mode: replace=整体替换正文 | append=追加到末尾 | prepend=插到开头；也可以只改标题或文件夹。',
      inputSchema: {
        id: z.string().describe('笔记 id'),
        mode: z.enum(['replace', 'append', 'prepend']).default('append'),
        content: z.string().optional().describe('Markdown 正文；append/prepend 时是增量片段'),
        title: z.string().optional().describe('新标题，省略则保留原标题'),
        folder: z.string().optional().describe('移动到指定文件夹名称'),
      },
    },
    async ({ id, mode, content, title, folder }) => {
      requireWrites(ctx, 'update_note');

      const { note } = await store.getBody(id);
      const currentMarkdown = note.markdown ?? '';

      let nextMarkdown = currentMarkdown;
      if (content !== undefined) {
        if (mode === 'replace') nextMarkdown = content;
        else if (mode === 'prepend') nextMarkdown = currentMarkdown ? `${content}\n\n${currentMarkdown}` : content;
        else nextMarkdown = currentMarkdown ? `${currentMarkdown}\n\n${content}` : content;
      }

      let folderId: string | undefined;
      if (folder && folder.trim()) {
        await store.ensureFresh(false);
        const found = store.folderByName(folder);
        if (!found) throw new Error(`找不到文件夹「${folder}」`);
        folderId = found.id;
      }

      const nextTitle = (title ?? note.subject ?? titleFromMarkdown(nextMarkdown, '无标题')).trim();
      await ctx.client.updateNote({
        id: note.id,
        tag: note.tag,
        title: nextTitle,
        body: markdownToNoteContent(nextMarkdown),
        ...(folderId !== undefined ? { folderId } : {}),
      });

      store.invalidate();
      return {
        content: [
          {
            type: 'text' as const,
            text: `已更新笔记「${nextTitle}」（${mode === 'replace' ? '整体替换' : mode === 'prepend' ? '前置插入' : '追加'}）`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'delete_note',
    {
      title: '删除笔记',
      description: '把笔记移到回收站（purge=true 则彻底删除）。这是破坏性操作，建议先向用户确认。',
      inputSchema: {
        id: z.string().describe('笔记 id'),
        purge: z.boolean().default(false).describe('是否彻底删除，默认仅移入回收站'),
      },
    },
    async ({ id, purge }) => {
      requireWrites(ctx, 'delete_note');
      // Always re-read: `tag` rotates on every write, so a cached one is stale
      // and the server answers 51006 "便签未被删除" instead of deleting.
      let target: NoteRecord;
      try {
        target = (await store.getBody(id)).note;
      } catch {
        await store.ensureFresh(true);
        const cached = store.get(id);
        if (!cached) throw new Error(`找不到笔记 ${id}`);
        target = cached;
      }
      await ctx.client.deleteNote(target.id, target.tag, purge);
      store.remove(id);
      store.invalidate();
      return {
        content: [
          { type: 'text' as const, text: `${purge ? '已彻底删除' : '已移入回收站'}：${target.subject || id}` },
        ],
      };
    },
  );

  server.registerTool(
    'create_folder',
    {
      title: '新建文件夹',
      description: '新建一个笔记文件夹。',
      inputSchema: {
        name: z.string().min(1).describe('文件夹名称'),
      },
    },
    async ({ name }) => {
      requireWrites(ctx, 'create_folder');
      const created = await ctx.client.createFolder(name);
      store.invalidate();
      return {
        content: [
          { type: 'text' as const, text: `已创建文件夹「${name}」${created.id ? `，id: ${created.id}` : ''}` },
        ],
      };
    },
  );
}

export { htmlToMarkdown };
