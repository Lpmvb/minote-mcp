import { inspectCookie, saveConfig, type Config } from '../config.js';
import {
  toFolder,
  toNote,
  type Folder,
  type Note,
  type RawFolder,
  type RawNoteMeta,
  type RawNotePage,
} from './types.js';

export interface MiNoteError extends Error {
  status?: number;
  body?: string;
}

const DEFAULT_BASE = 'https://i.mi.com';

function makeError(message: string, status?: number, body?: string): MiNoteError {
  const err = new Error(message) as MiNoteError;
  if (status !== undefined) err.status = status;
  if (body !== undefined) err.body = body;
  return err;
}

interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  mergeFromSetCookie(headers: string[]): void;
  toString(): string;
  names(): string[];
}

const COOKIE_ATTRS = new Set([
  'path',
  'domain',
  'expires',
  'secure',
  'httponly',
  'samesite',
  'max-age',
  'priority',
  'partitioned',
]);

function createJar(initial: string): CookieJar {
  const map = new Map<string, string>();

  const store = (name: string, value: string, expired: boolean): void => {
    if (!name) return;
    if (COOKIE_ATTRS.has(name.toLowerCase())) return;
    let v = value.trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    if (expired || v === '') map.delete(name);
    else map.set(name, v);
  };

  /**
   * Parse a `Cookie:` request-header style string — `a=1; b=2; c=3`.
   * Every `;`-separated part is a cookie here, NOT an attribute. (This is the
   * shape users paste from DevTools, so getting it right matters.)
   */
  const absorbCookieHeader = (header: string): void => {
    for (const part of header.split(';')) {
      const kv = part.trim();
      const idx = kv.indexOf('=');
      if (idx === -1) continue;
      store(kv.slice(0, idx).trim(), kv.slice(idx + 1).trim(), false);
    }
  };

  /**
   * Parse one `Set-Cookie:` response header — `name=value; Path=/; Max-Age=0`.
   * The first part is the cookie; the rest are attributes. Xiaomi clears with an
   * empty value or Max-Age=0 before setting the real one, and writes the same
   * name for `.mi.com` and `.i.mi.com` in one response, so last write must win.
   */
  const absorbSetCookie = (header: string): void => {
    const parts = header.split(';');
    const head = (parts[0] ?? '').trim();
    const idx = head.indexOf('=');
    if (idx === -1) return;

    const expired = parts.slice(1).some((attr) => {
      const a = attr.trim().toLowerCase();
      return a.startsWith('max-age=0') || a.startsWith('max-age=-');
    });

    store(head.slice(0, idx).trim(), head.slice(idx + 1).trim(), expired);
  };

  absorbCookieHeader(initial);

  return {
    get: (name) => map.get(name),
    set: (name, value) => {
      map.set(name, value);
    },
    mergeFromSetCookie(headers) {
      for (const raw of headers) {
        // A Set-Cookie header may pack several cookies. Split on ", name=" —
        // commas inside Expires dates are followed by a space and a digit, not
        // by an identifier, so this does not truncate dates.
        for (const segment of raw.split(/,(?=\s*[A-Za-z0-9_.\-]+=)/)) {
          absorbSetCookie(segment);
        }
      }
    },
    toString() {
      return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    names() {
      return [...map.keys()];
    },
  };
}

export interface ClientOptions {
  /** i.mi.com session cookie (serviceToken / userId / i.mi.com_ph). */
  cookie: string;
  /** Optional `.xiaomi.com` account cookie, required to mint a new session. */
  accountCookie?: string;
  userAgent: string;
  locale?: string;
  baseUrl?: string;
  /** Called with a refreshed cookie string so it can be persisted. */
  onCookieRefresh?: (cookie: string) => void;
}

export class MiNoteClient {
  private jar: CookieJar;
  private accountCookie: string;
  private userAgent: string;
  private locale: string;
  private base: string;
  private onCookieRefresh?: (cookie: string) => void;
  private refreshing: Promise<boolean> | null = null;

  constructor(opts: ClientOptions) {
    this.jar = createJar(opts.cookie);
    this.accountCookie = (opts.accountCookie ?? '').trim();
    this.userAgent = opts.userAgent;
    this.locale = opts.locale ?? 'zh_CN';
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
    this.onCookieRefresh = opts.onCookieRefresh;
  }


  static fromConfig(cfg: Config, opts: { persist?: boolean } = {}): MiNoteClient {
    return new MiNoteClient({
      cookie: cfg.cookie,
      accountCookie: cfg.accountCookie,
      userAgent: cfg.userAgent,
      locale: cfg.locale,
      baseUrl: cfg.baseUrl,
      onCookieRefresh: opts.persist
        ? (cookie) => {
            saveConfig({ cookie });
          }
        : undefined,
    });
  }

  cookieNames(): string[] {
    return this.jar.names();
  }

  private headers(method: string): Record<string, string> {
    const isMobile = /iPhone|Android|Mobile/.test(this.userAgent);
    const h: Record<string, string> = {
      Cookie: this.jar.toString(),
      'User-Agent': this.userAgent,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      priority: 'u=1, i',
      Referer: `${this.base}/note/h5`,
      'Sec-Ch-Ua-Mobile': isMobile ? '?1' : '?0',
      'Sec-Ch-Ua-Platform': isMobile ? '"iOS"' : '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    };
    if (method !== 'GET' && method !== 'HEAD') {
      // Critical: XSRF token must only accompany mutating requests.
      const ph = this.jar.get('i.mi.com_ph') ?? this.jar.get('ph');
      if (ph) h['X-XSRF-TOKEN'] = ph;
      h['X-Requested-With'] = 'XMLHttpRequest';
    }
    return h;
  }

  private now(): number {
    return Date.now();
  }

  /**
   * Exchange the account cookie for a fresh i.mi.com STS session.
   *
   * Two steps matter and both are easy to get wrong:
   *   1. `/api/user/login` returns the *account* login URL, signed for i.mi.com.
   *   2. Hitting that URL 302s to `https://i.mi.com/sts?...`. We must follow that
   *      hop with the ACCOUNT cookies attached, because the account session
   *      lives on `.xiaomi.com` — the i.mi.com jar is irrelevant here.
   *   3. The STS endpoint answers with Set-Cookie for `.i.mi.com`.
   *
   * `redirect: 'manual'` hides intermediate Set-Cookie headers, so we follow
   * hops by hand and merge cookies at every step.
   *
   * CRITICAL: run the whole exchange against a THROWAWAY jar and only adopt it
   * on success. Xiaomi clears `serviceToken` with `Max-Age=0` mid-flight, so a
   * failed refresh that mutated the live jar would log the user out for good.
   */
  private async refreshCookie(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;

    // Refreshing requires the `.xiaomi.com` account session. Attempting it with
    // only a service cookie makes passport bounce to the login form, and Xiaomi
    // clears the serviceToken as part of that bounce — so a speculative refresh
    // would actively destroy a session that might still have been valid.
    if (!this.accountCookie.trim()) return false;

    const accountHeaders = [this.accountCookie, this.jar.toString()].filter((p) => p.trim()).join('; ');

    this.refreshing = (async () => {
      try {
        const loginUrlResp = await fetch(
          `${this.base}/api/user/login?&followUp=${encodeURIComponent(`${this.base}/`)}&_locale=${this.locale}&ts=${this.now()}`,
          { headers: { 'User-Agent': this.userAgent, Cookie: accountHeaders, Accept: '*/*' } },
        );
        if (!loginUrlResp.ok) return false;

        const body = (await loginUrlResp.json()) as { data?: { loginUrl?: string } };
        const loginUrl = body?.data?.loginUrl;
        if (!loginUrl) return false;

        // Collect every Set-Cookie from the whole hop chain into a staging list.
        const staged: string[] = [];
        let current = loginUrl;

        for (let hop = 0; hop < 6; hop++) {
          // The passport hosts (account.xiaomi.com) only want the account
          // session. Sending them the i.mi.com jar as well makes the next hop
          // fall back to the login form instead of 302-ing to /sts.
          // Without an accountCookie there is no passport session to send, so
          // fall back to the jar — that still works when the user pasted only
          // the service cookie and it merely needs a fresh STS exchange.
          const isPassportHost = /(^|\.)account\.xiaomi\.com$/.test(new URL(current).hostname);
          const cookieHeader =
            isPassportHost && this.accountCookie
              ? this.accountCookie
              : [this.accountCookie, this.jar.toString()].filter(Boolean).join('; ');

          const resp = await fetch(current, {
            redirect: 'manual',
            headers: {
              'User-Agent': this.userAgent,
              Cookie: cookieHeader,
              Accept: 'text/html,application/xhtml+xml,*/*',
            },
          });

          staged.push(...(resp.headers.getSetCookie?.() ?? []));

          // The STS hop is the finish line: once it hands us a service session
          // there is nothing left to collect, and the next Location (usually
          // just the site root) would be a wasted — sometimes failing — request.
          if (staged.length > 0) {
            const probe = createJar('');
            probe.mergeFromSetCookie(staged);
            if (probe.get('serviceToken') && probe.get('i.mi.com_ph')) break;
          }

          const next = resp.headers.get('location');
          if (!next) break;
          current = new URL(next, current).toString();
        }

        if (staged.length === 0) return false;

        // Only adopt i.mi.com's own cookies. The passport hop also sets
        // `.xiaomi.com` cookies (passToken, cUserId…) and those belong in the
        // *account* jar — letting them into the service jar means every API
        // request carries the account session too, which is both wrong and a
        // needless credential leak.
        const serviceScoped = staged.filter((raw) => {
          const domain = /;\s*domain=([^;]+)/i.exec(raw)?.[1]?.trim().toLowerCase() ?? '';
          if (!domain) return true; // host-only cookie from the STS host
          return domain.endsWith('i.mi.com') || domain === 'mi.com' || domain.endsWith('.mi.com');
        });
        if (serviceScoped.length === 0) return false;

        // Dry-run the merge on a copy to confirm we'd end up with a usable session.
        const probe = createJar(this.jar.toString());
        probe.mergeFromSetCookie(serviceScoped);
        if (!probe.get('serviceToken') || !probe.get('i.mi.com_ph')) return false;

        // Commit.
        this.jar.mergeFromSetCookie(serviceScoped);
        this.onCookieRefresh?.(this.jar.toString());
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }


  private async request(
    method: 'GET' | 'POST',
    path: string,
    form?: Record<string, string>,
  ): Promise<unknown> {
    const url = path.startsWith('http') ? path : `${this.base}${path}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      const init: RequestInit = { method, headers: this.headers(method) };
      if (form) {
        init.body = new URLSearchParams(form).toString();
        (init.headers as Record<string, string>)['Content-Type'] =
          'application/x-www-form-urlencoded; charset=UTF-8';
      }

      const resp = await fetch(url, init).catch((e: unknown) => {
        throw makeError(`网络请求失败: ${(e as Error).message}`);
      });

      if (resp.status === 401 || resp.status === 403) {
        const text = await resp.text();
        if (attempt < 2 && (await this.refreshCookie())) continue;
        throw makeError(
          '小米账号登录态已失效，请重新从浏览器复制 cookie（设置 MINOTE_COOKIE 或运行 npm run login）',
          resp.status,
          text.slice(0, 500),
        );
      }

      const text = await resp.text();
      if (!resp.ok) {
        throw makeError(`i.mi.com 返回 ${resp.status}`, resp.status, text.slice(0, 500));
      }

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw makeError('i.mi.com 返回了非 JSON 响应', resp.status, text.slice(0, 500));
      }

      const obj = json as { R?: number; S?: string; D?: unknown; data?: unknown; result?: string; code?: number; description?: string; reason?: string };
      if (obj.R === 401 || obj.S === 'Err') {
        if (attempt < 2 && (await this.refreshCookie())) continue;
        throw makeError(
          `小米接口拒绝请求: ${JSON.stringify(obj.D ?? obj).slice(0, 300)}`,
          401,
          text.slice(0, 500),
        );
      }

      // i.mi.com reports application-level failures with HTTP 200 and a body
      // like {"result":"error","code":51006,"description":"便签未被删除"}.
      // Treating that as success is how a delete silently does nothing.
      if (obj.result === 'error' || (typeof obj.code === 'number' && obj.code !== 0)) {
        throw makeError(
          `小米接口报错 ${obj.code ?? ''}: ${obj.description ?? obj.reason ?? '未知原因'}`,
          200,
          text.slice(0, 500),
        );
      }

      return obj.data ?? obj;
    }

    throw makeError('请求重试 3 次仍失败');
  }

  // ---------------------------------------------------------------- reads

  /** One page of note metadata. `syncTag` enables incremental pulls. */
  async listPage(limit = 200, syncTag?: string): Promise<RawNotePage> {
    const params = new URLSearchParams({ limit: String(limit), ts: String(this.now()) });
    if (syncTag) params.set('syncTag', syncTag);
    const data = (await this.request('GET', `/note/full/page/?${params.toString()}`)) as RawNotePage;
    return data ?? {};
  }

  /** Walk all pages and return every note + folder. */
  async listAll(options: { maxNotes?: number; pageSize?: number } = {}): Promise<{
    notes: Note[];
    folders: Folder[];
    pages: number;
  }> {
    const pageSize = options.pageSize ?? 200;
    const maxNotes = options.maxNotes ?? 20000;
    const notes = new Map<string, Note>();
    const folders = new Map<string, Folder>();
    let syncTag: string | undefined;
    let pages = 0;

    for (;;) {
      const page = await this.listPage(pageSize, syncTag);
      pages++;
      const entries = page.entries ?? [];
      for (const raw of entries) {
        const n = toNote(raw as RawNoteMeta);
        if (n.status === 'deleted') continue;
        notes.set(n.id, n);
      }
      for (const raw of page.folders ?? []) {
        const f = toFolder(raw as RawFolder);
        folders.set(f.id, f);
      }

      // Stop when the server says it's done, when it hands back no next cursor,
      // when the cursor stops advancing (guards against an infinite loop on a
      // misbehaving response), or when a page came back empty.
      const nextTag = page.syncTag === null || page.syncTag === undefined ? undefined : String(page.syncTag);
      if (page.lastPage === true) break;
      if (!nextTag || nextTag === syncTag) break;
      if (entries.length === 0) break;
      if (notes.size >= maxNotes) break;
      syncTag = nextTag;
    }

    return { notes: [...notes.values()], folders: [...folders.values()], pages };
  }

  async getNote(id: string): Promise<Note> {
    // NOTE the trailing slash — the h5 client calls "/note/note/{id}/". The
    // version without it happens to work for some accounts but is not the
    // documented-by-code path.
    const data = (await this.request(
      'GET',
      `/note/note/${encodeURIComponent(id)}/?ts=${this.now()}`,
    )) as { entry?: RawNoteMeta } | RawNoteMeta;
    const raw = (data as { entry?: RawNoteMeta }).entry ?? (data as RawNoteMeta);
    if (!raw || raw.id === undefined) throw makeError(`找不到笔记 ${id}`);
    return toNote(raw);
  }

  // --------------------------------------------------------------- writes

  /**
   * Create a note.
   *
   * The h5 client does `POST /note/note { entry: <object> }` — note that for
   * CREATE the entry is sent as an object, while UPDATE sends it as a JSON
   * string. Both quirks are load-bearing; mixing them up yields 4xx.
   */
  async createNote(args: {
    title: string;
    body: string;
    folderId?: string;
    colorId?: number;
  }): Promise<Note> {
    const entry = {
      // Modern notes carry the title in extraInfo; `subject` is kept for older clients.
      subject: args.title,
      extraInfo: JSON.stringify({ title: args.title, note_content_type: 'common' }),
      content: args.body,
      folderId: args.folderId ?? '0',
      colorId: args.colorId ?? 0,
      type: 'note',
      status: 'normal',
    };
    const data = (await this.request('POST', '/note/note', {
      entry: JSON.stringify(entry),
      serviceToken: this.jar.get('serviceToken') ?? '',
    })) as { entry?: RawNoteMeta } | RawNoteMeta;
    const raw = (data as { entry?: RawNoteMeta }).entry ?? (data as RawNoteMeta);
    if (raw && raw.id !== undefined) return toNote(raw);
    // Some responses omit the entry; caller should re-list.
    return {
      id: '',
      tag: '',
      folderId: args.folderId ?? '0',
      subject: args.title,
      snippet: '',
      createDate: Date.now(),
      modifyDate: Date.now(),
      colorId: args.colorId ?? 0,
      status: 'normal',
      type: 'note',
    };
  }

  async updateNote(args: {
    id: string;
    tag: string;
    title: string;
    body: string;
    folderId?: string;
    colorId?: number;
  }): Promise<Note> {
    const entry: Record<string, unknown> = {
      id: args.id,
      tag: args.tag,
      subject: args.title,
      extraInfo: JSON.stringify({ title: args.title, note_content_type: 'common' }),
      content: args.body,
      modifyDate: Date.now(),
    };
    if (args.folderId !== undefined) entry.folderId = args.folderId;
    if (args.colorId !== undefined) entry.colorId = args.colorId;

    // UPDATE sends `entry` as a JSON *string* — the h5 client does
    // JSON.stringify(t) here but passes the plain object on create.
    await this.request('POST', `/note/note/${encodeURIComponent(args.id)}`, {
      tag: args.tag,
      entry: JSON.stringify(entry),
      serviceToken: this.jar.get('serviceToken') ?? '',
    });

    // The update response echoes a stub (subject/extraInfo blank, createDate 0),
    // so it is useless as a source of truth. Re-read the note instead — that is
    // also what proves the write actually landed.
    return this.getNote(args.id);
  }

  /**
   * Delete a note.
   *
   * The server only allows a hard delete (`purge=true`) once the note is already
   * in the trash — calling it directly returns
   * `{"result":"error","code":51006,"description":"便签未被删除"}` with HTTP 200.
   * So a purge is really "trash, then purge".
   */
  async deleteNote(id: string, tag: string, purge = false): Promise<void> {
    let currentTag = tag;

    const call = (p: boolean): Promise<unknown> =>
      this.request('POST', `/note/full/${encodeURIComponent(id)}/delete`, {
        tag: currentTag,
        purge: String(p),
        serviceToken: this.jar.get('serviceToken') ?? '',
      });

    /** Re-read to pick up the tag the last write rotated to. */
    const refreshTag = async (): Promise<boolean> => {
      try {
        const fresh = await this.getNote(id);
        if (fresh.tag) {
          currentTag = fresh.tag;
          return true;
        }
      } catch {
        // Already gone, or unreadable — the caller decides what to do.
      }
      return false;
    };

    if (!purge) {
      try {
        await call(false);
        return;
      } catch (e) {
        if (!(await refreshTag())) throw e;
        await call(false);
        return;
      }
    }

    // Hard delete: needs a current tag AND the note already in the trash.
    try {
      await call(true);
      return;
    } catch {
      await refreshTag();
    }

    await call(false).catch(() => {
      // Already trashed; the purge below reports the real outcome.
    });
    await call(true);
  }

  // -------------------------------------------------------------- folders

  async createFolder(subject: string, parentId = '0'): Promise<Folder> {
    const entry = { subject, folderId: parentId, type: 'folder', status: 'normal' };
    const data = (await this.request('POST', '/note/folder', {
      entry: JSON.stringify(entry),
      serviceToken: this.jar.get('serviceToken') ?? '',
    })) as { folder?: RawFolder } | RawFolder;
    const raw = (data as { folder?: RawFolder }).folder ?? (data as RawFolder);
    if (raw && raw.id !== undefined) return toFolder(raw);
    return { id: '', tag: '', parentId, subject, createDate: Date.now(), modifyDate: Date.now() };
  }

  async renameFolder(id: string, tag: string, subject: string): Promise<void> {
    const entry = { id, tag, subject, type: 'folder', status: 'normal' };
    await this.request('POST', `/note/folder/${encodeURIComponent(id)}`, {
      entry: JSON.stringify(entry),
      serviceToken: this.jar.get('serviceToken') ?? '',
    });
  }

  async deleteFolder(id: string, tag: string): Promise<void> {
    // The h5 client reuses the generic delete endpoint for folders too.
    await this.request('POST', `/note/full/${encodeURIComponent(id)}/delete`, {
      tag,
      purge: 'false',
      serviceToken: this.jar.get('serviceToken') ?? '',
    });
  }
}

export function assertCookieLooksValid(cookie: string): void {
  const info = inspectCookie(cookie);
  if (!info.ok) {
    throw makeError(
      `cookie 不完整（缺少 ${[!info.hasServiceToken ? 'serviceToken' : '', !info.hasUserId ? 'userId' : '']
        .filter(Boolean)
        .join(', ')}）`,
    );
  }
}
