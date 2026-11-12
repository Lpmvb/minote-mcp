/**
 * A faithful-enough mock of i.mi.com's notes API, used by the integration test.
 *
 * It enforces the quirks we discovered in the real thing:
 *   - 401 + {"R":401,...} when the STS cookie is missing/expired
 *   - X-XSRF-TOKEN required on POST (value must equal the i.mi.com_ph cookie)
 *   - serviceToken required on POST body
 *   - pagination via syncTag + lastPage
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface MockNote {
  id: number;
  tag: number;
  folderId: number;
  subject: string;
  extraInfo?: string;
  content: string;
  snippet: string;
  createDate: number;
  modifyDate: number;
  colorId: number;
  status: string;
  type: string;
}

interface MockFolder {
  id: number;
  tag: number;
  folderId: number;
  subject: string;
  createDate: number;
  modifyDate: number;
}

export interface MockOptions {
  cookie: string;
  /** Number of notes per page when the client doesn't ask. */
  pageSize?: number;
  notes?: Array<Partial<MockNote> & { subject: string }>;
  folders?: Array<{ id: number; subject: string }>;
}

export interface MockHandle {
  url: string;
  port: number;
  notes: MockNote[];
  folders: MockFolder[];
  /** Flip to make every request 401 (simulates an expired session). */
  expire(): void;
  /** Flip back; the STS exchange will hand out a fresh cookie. */
  unexpire(): void;
  requests: Array<{ method: string; path: string; xsrf?: string; body?: string }>;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    map.set(part.slice(0, idx).trim(), part.slice(idx + 1).trim());
  }
  return map;
}

/**
 * The real API quotes ids and tags (they exceed Number.MAX_SAFE_INTEGER) and
 * carries the display title in extraInfo as JSON. Mirror both, otherwise the
 * client's string handling looks fine in tests and breaks against production.
 */
function serializeNote(n: MockNote): Record<string, unknown> {
  return {
    ...n,
    id: String(n.id),
    tag: String(n.tag),
    folderId: String(n.folderId),
    extraInfo: n.extraInfo ?? JSON.stringify({ title: n.subject, note_content_type: 'common' }),
  };
}

function serializeFolder(f: MockFolder): Record<string, unknown> {
  return { ...f, id: String(f.id), tag: String(f.tag), folderId: String(f.folderId) };
}

function htmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function startMockMicloud(opts: MockOptions): Promise<MockHandle> {
  const now = Date.now();
  const notes: MockNote[] = (opts.notes ?? []).map((n, i) => ({
    id: n.id ?? 1000 + i,
    tag: n.tag ?? 1000 + i,
    folderId: n.folderId ?? 0,
    subject: n.subject ?? '',
    content: n.content ?? `<p>${htmlEscape(n.subject ?? '')}</p>`,
    snippet: n.snippet ?? htmlEscape(n.subject ?? ''),
    createDate: n.createDate ?? now - (i + 1) * 60_000,
    modifyDate: n.modifyDate ?? now - (i + 1) * 60_000,
    colorId: n.colorId ?? 0,
    status: n.status ?? 'normal',
    type: n.type ?? 'note',
  }));
  const folders: MockFolder[] = (opts.folders ?? []).map((f) => ({
    id: f.id,
    tag: f.id,
    folderId: 0,
    subject: f.subject,
    createDate: now,
    modifyDate: now,
  }));

  const requests: MockHandle['requests'] = [];
  let expired = false;
  let nextId = 9000;

  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(text);
  };

  const unauthorized = (res: ServerResponse): void => {
    send(res, 401, {
      R: 401,
      S: 'Err',
      D: 'https://account.xiaomi.com/pass/serviceLogin?callback=x&sid=i.mi.com',
      E: false,
    });
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = req.method === 'GET' ? '' : await readBody(req);
      const cookies = parseCookies(req.headers.cookie);
      requests.push({ method: req.method ?? '', path: url.pathname, xsrf: req.headers['x-xsrf-token'] as string | undefined, body });

      // ---- STS login flow (works even while "expired") ----
      if (url.pathname === '/api/user/login') {
        send(res, 200, {
          R: 0,
          S: 'Ok',
          data: { loginUrl: `http://127.0.0.1:${port()}/pass/serviceLogin?id=1` },
        });
        return;
      }
      if (url.pathname === '/pass/serviceLogin') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port()}/sts?exchange=1` });
        res.end();
        return;
      }
      if (url.pathname === '/sts') {
        res.writeHead(302, {
          'Set-Cookie': [
            `i.mi.com_slh=fresh-slh-${Date.now()}; Path=/`,
            `i.mi.com_ph=fresh-ph-${Date.now()}; Path=/`,
            'serviceToken=fresh-service-token; Path=/',
          ],
          Location: 'http://127.0.0.1/',
        });
        res.end();
        expired = false;
        return;
      }

      const token = cookies.get('serviceToken') ?? '';
      const hasSession = token === opts.cookie.split('serviceToken=')[1]?.split(/[;&]/)[0] || token.startsWith('fresh-');
      if (!hasSession || expired) {
        unauthorized(res);
        return;
      }

      // ---- reads ----
      if (url.pathname === '/note/full/page/' && req.method === 'GET') {
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
        const syncTag = Number.parseInt(url.searchParams.get('syncTag') ?? '0', 10) || 0;
        const live = notes.filter((n) => n.status !== 'deleted');
        const slice = live.slice(syncTag, syncTag + limit);
        const nextTag = syncTag + slice.length;
        const lastPage = nextTag >= live.length;
        send(res, 200, {
          R: 0,
          S: 'Ok',
          data: {
            entries: slice.map(serializeNote),
            folders: folders.map(serializeFolder),
            lastPage,
            syncTag: lastPage ? null : nextTag,
          },
        });
        return;
      }

      const noteMatch = /^\/note\/note\/(\d+)\/?$/.exec(url.pathname);
      if (noteMatch && req.method === 'GET') {
        const id = Number(noteMatch[1]);
        const note = notes.find((n) => n.id === id);
        if (!note) {
          send(res, 404, { R: 404, S: 'Err', D: 'not found' });
          return;
        }
        send(res, 200, { R: 0, S: 'Ok', data: { entry: serializeNote(note) } });
        return;
      }

      // ---- writes ----
      if (url.pathname === '/note/note' && req.method === 'POST') {
        if (req.headers['x-xsrf-token'] !== cookies.get('i.mi.com_ph')) {
          send(res, 403, { R: 403, S: 'Err', D: 'xsrf mismatch' });
          return;
        }
        const form = new URLSearchParams(body);
        if (!form.get('serviceToken')) {
          send(res, 400, { R: 400, S: 'Err', D: 'missing serviceToken' });
          return;
        }
        const entry = JSON.parse(form.get('entry') ?? '{}') as {
          subject?: string;
          content?: string;
          extraInfo?: string;
          folderId?: string;
          colorId?: number;
        };
        const id = nextId++;
        const title = (() => {
          try {
            return (JSON.parse(entry.extraInfo ?? '{}') as { title?: string }).title ?? entry.subject ?? '';
          } catch {
            return entry.subject ?? '';
          }
        })();
        const created: MockNote = {
          id,
          tag: id,
          subject: title,
          folderId: entry.folderId ? Number(entry.folderId) : 0,
          subject: entry.subject ?? '',
          content: entry.content ?? '',
          snippet: (entry.content ?? '').replace(/<[^>]+>/g, ' ').trim(),
          createDate: Date.now(),
          modifyDate: Date.now(),
          colorId: entry.colorId ?? 0,
          status: 'normal',
          type: 'note',
        };
        notes.push(created);
        send(res, 200, { R: 0, S: 'Ok', data: { entry: serializeNote(created) } });
        return;
      }

      if (noteMatch && req.method === 'POST') {
        if (req.headers['x-xsrf-token'] !== cookies.get('i.mi.com_ph')) {
          send(res, 403, { R: 403, S: 'Err', D: 'xsrf mismatch' });
          return;
        }
        const form = new URLSearchParams(body);
        if (!form.get('serviceToken')) {
          send(res, 400, { R: 400, S: 'Err', D: 'missing serviceToken' });
          return;
        }
        const id = Number(noteMatch[1]);
        const note = notes.find((n) => n.id === id);
        if (!note) {
          send(res, 404, { R: 404, S: 'Err', D: 'not found' });
          return;
        }
        const entry = JSON.parse(form.get('entry') ?? '{}') as {
          subject?: string;
          content?: string;
          folderId?: string;
        };
        if (entry.subject !== undefined) note.subject = entry.subject;
        if (entry.content !== undefined) {
          note.content = entry.content;
          note.snippet = entry.content.replace(/<[^>]+>/g, ' ').trim();
        }
        if (entry.folderId !== undefined) note.folderId = Number(entry.folderId);
        note.modifyDate = Date.now();
        send(res, 200, { R: 0, S: 'Ok', data: { entry: serializeNote(note) } });
        return;
      }

      const delMatch = /^\/note\/full\/(\d+)\/delete$/.exec(url.pathname);
      if (delMatch && req.method === 'POST') {
        if (req.headers['x-xsrf-token'] !== cookies.get('i.mi.com_ph')) {
          send(res, 403, { R: 403, S: 'Err', D: 'xsrf mismatch' });
          return;
        }
        const id = Number(delMatch[1]);
        const note = notes.find((n) => n.id === id);
        if (!note) {
          send(res, 404, { R: 404, S: 'Err', D: 'not found' });
          return;
        }
        const form = new URLSearchParams(body);
        const wantPurge = form.get('purge') === 'true';

        // Real behaviour: a hard delete is only allowed once the note is already
        // in the trash, otherwise it answers 200 + {result:"error", code:51006}.
        if (wantPurge && note.status !== 'deleted') {
          send(res, 200, {
            result: 'error',
            retriable: false,
            code: 51006,
            description: '便签未被删除',
            reason: 'make sure if note is deleted',
          });
          return;
        }

        note.status = 'deleted';
        send(res, 200, {
          result: 'ok',
          code: 0,
          data: { id: String(id), tag: String(note.tag), conflict: false },
        });
        return;
      }

      if (url.pathname === '/note/folder' && req.method === 'POST') {
        const form = new URLSearchParams(body);
        const entry = JSON.parse(form.get('entry') ?? '{}') as { subject?: string; folderId?: string };
        const id = nextId++;
        const folder: MockFolder = {
          id,
          tag: id,
          folderId: Number(entry.folderId ?? 0),
          subject: entry.subject ?? '',
          createDate: Date.now(),
          modifyDate: Date.now(),
        };
        folders.push(folder);
        send(res, 200, { R: 0, S: 'Ok', data: { folder: serializeFolder(folder) } });
        return;
      }

      send(res, 404, { R: 404, S: 'Err', D: `unhandled ${req.method} ${url.pathname}` });
    })();
  });

  const port = (): number => (server.address() as AddressInfo).port;

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${port()}`;

  return {
    url,
    port: port(),
    notes,
    folders,
    expire: () => {
      expired = true;
    },
    unexpire: () => {
      expired = false;
    },
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
