import type { MiNoteClient } from './micloud/client.js';
import type { Folder, Note } from './micloud/types.js';
import { htmlToMarkdown } from './convert/markdown.js';

export interface NoteRecord extends Note {
  /** Markdown body — only filled for notes we've fetched or created. */
  markdown?: string;
}

export interface StoreOptions {
  ttlMs?: number;
}

/**
 * Metadata cache in front of the i.mi.com list endpoint.
 *
 * The list call returns every note's snippet + timestamps, which is enough for
 * listing and cheap search. Bodies are fetched lazily.
 *
 * Two invariants that matter:
 *   1. `tag` rotates on every write, so a cached note's tag goes stale the
 *      moment anything touches it. Writes must invalidate, and callers must
 *      re-read before a follow-up write.
 *   2. A cached body is only valid while the note's `modifyDate` is unchanged.
 */
export class NoteStore {
  private client: MiNoteClient;
  private ttlMs: number;
  private notes = new Map<string, NoteRecord>();
  private folders = new Map<string, Folder>();
  private lastSync = 0;
  private syncing: Promise<void> | null = null;

  constructor(client: MiNoteClient, opts: StoreOptions = {}) {
    this.client = client;
    this.ttlMs = opts.ttlMs ?? 60_000;
  }

  get syncedAt(): number {
    return this.lastSync;
  }

  async ensureFresh(force = false): Promise<void> {
    const stale = Date.now() - this.lastSync > this.ttlMs;
    if (!force && !stale && this.notes.size > 0) return;
    if (this.syncing) return this.syncing;

    this.syncing = (async () => {
      const { notes, folders } = await this.client.listAll();
      const next = new Map<string, NoteRecord>();
      for (const n of notes) {
        const cached = this.notes.get(n.id);
        // Keep a cached body only when the note hasn't changed on the server.
        const body = cached && cached.modifyDate === n.modifyDate ? cached.markdown : undefined;
        next.set(n.id, body === undefined ? n : { ...n, markdown: body });
      }
      this.notes = next;
      this.folders = new Map(folders.map((f) => [f.id, f]));
      this.lastSync = Date.now();
    })().finally(() => {
      this.syncing = null;
    });

    return this.syncing;
  }

  /** Drop cached state — call after any write, since tags rotate. */
  invalidate(): void {
    this.lastSync = 0;
    for (const [id, note] of this.notes) {
      this.notes.set(id, { ...note, markdown: undefined });
    }
  }

  allNotes(): NoteRecord[] {
    return [...this.notes.values()];
  }

  allFolders(): Folder[] {
    return [...this.folders.values()];
  }

  folderName(id: string): string {
    if (!id || id === '0') return '（未分类）';
    return this.folders.get(id)?.subject ?? id;
  }

  folderByName(name: string): Folder | undefined {
    const needle = name.trim();
    return this.allFolders().find((f) => f.subject.trim() === needle);
  }

  get(id: string): NoteRecord | undefined {
    return this.notes.get(id);
  }

  /**
   * Fetch a body once and remember it.
   *
   * Always hits the network for the note itself (it's one small request) so the
   * returned `tag` is current — using a stale tag makes the next write fail with
   * "便签未被删除" / conflict.
   */
  async getBody(id: string): Promise<{ note: NoteRecord; markdown: string }> {
    const fresh = await this.client.getNote(id);
    const markdown = htmlToMarkdown(fresh.body ?? '');
    const record: NoteRecord = { ...fresh, markdown };
    this.notes.set(id, record);
    return { note: record, markdown };
  }

  /** Body straight from cache if possible — used by search, which already synced. */
  async peekMarkdown(id: string): Promise<string | undefined> {
    const cached = this.notes.get(id);
    if (cached?.markdown !== undefined) return cached.markdown;
    const { markdown } = await this.getBody(id);
    return markdown;
  }

  upsert(note: NoteRecord): void {
    this.notes.set(note.id, note);
    this.lastSync = 0;
  }

  remove(id: string): void {
    this.notes.delete(id);
  }

  /** Sorted newest-modified first. */
  sorted(): NoteRecord[] {
    return this.allNotes().sort((a, b) => b.modifyDate - a.modifyDate);
  }
}
