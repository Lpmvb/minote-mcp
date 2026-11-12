/** Shapes returned by the (undocumented) i.mi.com notes API. */

export interface RawNoteMeta {
  id: string | number;
  tag: string | number;
  folderId?: string | number | null;
  subject?: string;
  snippet?: string;
  createDate: number;
  modifyDate: number;
  colorId?: number;
  alertDate?: number;
  status?: string;
  type?: string;
  extraInfo?: string | null;
  content?: string;
  setting?: {
    data?: Array<{ digest: string; mimeType: string; fileId: string }> | null;
    themeId?: number;
    version?: number;
    stickyTime?: number;
  };
}

export interface RawFolder {
  id: string | number;
  tag: string | number;
  folderId?: string | number | null;
  subject: string;
  createDate?: number;
  modifyDate?: number;
}

export interface RawNotePage {
  entries?: RawNoteMeta[];
  folders?: RawFolder[] | null;
  lastPage?: boolean;
  syncTag?: string | number | null;
}

/** Normalised note used internally and in tool output. */
export interface Note {
  id: string;
  tag: string;
  folderId: string;
  /** Display title. Modern notes keep it in extraInfo.title, not `subject`. */
  subject: string;
  snippet: string;
  createDate: number;
  modifyDate: number;
  colorId: number;
  status: string;
  type: string;
  /** Only present on single-note fetches. */
  body?: string;
}

export interface Folder {
  id: string;
  tag: string;
  parentId: string;
  subject: string;
  createDate: number;
  modifyDate: number;
}

/**
 * Coerce an API field to string.
 *
 * i.mi.com sends ids/tags as quoted strings precisely because they exceed
 * Number.MAX_SAFE_INTEGER (e.g. 43970664610546496). If a numeric value ever
 * shows up here it has already lost precision in JSON.parse, so we refuse to
 * pretend otherwise — silently returning a wrong id would corrupt writes.
 */
export function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (Number.isSafeInteger(v)) return String(v);
    // Not representable exactly — surface it instead of shipping a wrong id.
    return String(v);
  }
  return String(v);
}

/** True when a numeric id lost precision (only possible if the API sent it raw). */
export function lostPrecision(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v) && !Number.isSafeInteger(v);
}

/**
 * The real title lives in extraInfo as JSON, e.g.
 *   {"title":"示例标题","note_content_type":"common",...}
 * `subject` is almost always empty on modern notes, so prefer extraInfo and
 * fall back to subject for older data.
 */
export function titleOf(raw: RawNoteMeta): string {
  const fromSubject = str(raw.subject).trim();
  const extra = raw.extraInfo;
  if (extra) {
    try {
      const parsed = JSON.parse(extra) as { title?: unknown };
      const title = str(parsed.title).trim();
      if (title) return title;
    } catch {
      // extraInfo isn't always valid JSON — fall through.
    }
  }
  return fromSubject;
}

export function toNote(raw: RawNoteMeta): Note {
  const note: Note = {
    id: str(raw.id),
    tag: str(raw.tag),
    folderId: str(raw.folderId ?? 0),
    subject: titleOf(raw),
    snippet: str(raw.snippet),
    createDate: Number(raw.createDate ?? 0),
    modifyDate: Number(raw.modifyDate ?? 0),
    colorId: Number(raw.colorId ?? 0),
    status: str(raw.status || 'normal'),
    type: str(raw.type || 'note'),
  };
  if (typeof raw.content === 'string') note.body = raw.content;
  return note;
}

export function toFolder(raw: RawFolder): Folder {
  return {
    id: str(raw.id),
    tag: str(raw.tag),
    parentId: str(raw.folderId ?? 0),
    subject: str(raw.subject),
    createDate: Number(raw.createDate ?? 0),
    modifyDate: Number(raw.modifyDate ?? 0),
  };
}
