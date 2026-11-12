/**
 * Read Xiaomi cookies straight from a local browser's cookie store.
 *
 * Three storage shapes are supported:
 *
 *   1. Chromium-family  — encrypted SQLite (`Cookies` file), AES-128-CBC with a
 *      key derived from the OS keychain password.
 *   2. Safari / WKWebView — `Cookies.binarycookies`, a binary format. This is
 *      what the Alma app's in-app browser uses, so it's the common case on this
 *      machine.
 *   3. Live browser      — attach over CDP (Chrome) and ask for cookies, which
 *      also works for HttpOnly cookies that the file on disk may not have
 *      flushed yet.
 *
 * Nothing here writes to the browser.
 */
import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type BrowserId = 'chrome' | 'dia' | 'edge' | 'arc' | 'brave' | 'alma' | 'safari';

interface ChromiumDef {
  kind: 'chromium';
  dir: string;
  keychainServices: string[];
}

interface WebKitDef {
  kind: 'webkit';
  /** Bundle id used for ~/Library/WebKit/<bundleId>. */
  bundleId: string;
}

type BrowserDef = ChromiumDef | WebKitDef;

const BROWSERS: Record<BrowserId, BrowserDef> = {
  chrome: { kind: 'chromium', dir: 'Google/Chrome', keychainServices: ['Chrome Safe Storage'] },
  dia: { kind: 'chromium', dir: 'Dia', keychainServices: ['Dia Safe Storage', 'Chrome Safe Storage'] },
  edge: {
    kind: 'chromium',
    dir: 'Microsoft Edge',
    keychainServices: ['Microsoft Edge Safe Storage', 'Chrome Safe Storage'],
  },
  arc: { kind: 'chromium', dir: 'Arc', keychainServices: ['Arc Safe Storage', 'Chrome Safe Storage'] },
  brave: {
    kind: 'chromium',
    dir: 'BraveSoftware/Brave-Browser',
    keychainServices: ['Brave Safe Storage', 'Chrome Safe Storage'],
  },
  alma: { kind: 'webkit', bundleId: 'com.yetone.alma' },
  safari: { kind: 'webkit', bundleId: 'com.apple.Safari' },
};

export interface BrowserCookieResult {
  /** i.mi.com session cookie (serviceToken / userId / i.mi.com_ph / i.mi.com_slh). */
  serviceCookie: string;
  /** `.xiaomi.com` account cookie — this is what makes refresh possible. */
  accountCookie: string;
  /** host -> cookie names found, for diagnostics. */
  hosts: Record<string, string[]>;
}

/**
 * Cookie names that belong to the i.mi.com service session.
 *
 * Allowlisting by name is deliberate: `.mi.com` also carries analytics cookies
 * (`_tt_enable_cookie`, `ttcsid`, `__lt__cid`…) which must NOT be sent to the
 * notes API — mixing them in produces a jar that looks non-empty but has no
 * real session, which is worse than an obviously empty one.
 */
const SERVICE_COOKIE_NAMES = new Set([
  'serviceToken',
  'userId',
  'i.mi.com_ph',
  'i.mi.com_slh',
  'i.mi.com_isvalid_servicetoken',
  'i.mi.com_istrudev',
]);

/** Cookie names that belong to the `.xiaomi.com` account session. */
const ACCOUNT_COOKIE_NAMES = new Set([
  'passToken',
  'cUserId',
  'userId',
  'passport_ph',
  'passport_slh',
  'pass_ua',
  'pass_ptd',
  'deviceId',
  'passInfo',
  'pass_sign',
  'scanInfo',
  'uLocale',
]);

function bucketFor(host: string): 'service' | 'account' | null {
  const h = host.replace(/^\./, '');
  if (h === 'account.xiaomi.com' || h.endsWith('.account.xiaomi.com')) return 'account';
  if (h === 'verify.infosec.xiaomi.com') return 'account';
  if (h === 'i.mi.com' || h.endsWith('.i.mi.com')) return 'service';
  if (h === 'mi.com' || h.endsWith('.mi.com')) return 'service';
  if (h === 'xiaomi.com' || h.endsWith('.xiaomi.com')) return 'account';
  return null;
}

// --------------------------------------------------------------------------
// Chromium (encrypted SQLite)
// --------------------------------------------------------------------------

async function keychainPassword(services: string[]): Promise<string | null> {
  for (const service of services) {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-w', '-s', service]);
      const pw = stdout.trim();
      if (pw) return pw;
    } catch {
      // try next
    }
  }
  return null;
}

function decryptChromiumValue(enc: Buffer, key: Buffer): string {
  const prefix = enc.length >= 3 ? enc.subarray(0, 3).toString('binary') : '';
  const body = prefix === 'v10' || prefix === 'v11' ? enc.subarray(3) : enc;
  if (body.length === 0 || body.length % 16 !== 0) return '';

  const iv = Buffer.alloc(16, 0x20);
  const decipher = createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return '';
  }

  // Chromium >= 24 prepends a 32-byte SHA-256 of the host key.
  for (const offset of [32, 0]) {
    if (plain.length <= offset) continue;
    const candidate = plain.subarray(offset).toString('utf8');
    if (candidate.length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(candidate)) {
      return candidate;
    }
  }
  return '';
}

async function readChromium(def: ChromiumDef, profile = 'Default'): Promise<Array<{ host: string; name: string; value: string }>> {
  const base = join(homedir(), 'Library', 'Application Support', def.dir);
  if (!existsSync(base)) throw new Error(`没找到浏览器数据目录: ${base}`);

  const candidates = [
    join(base, 'User Data', profile, 'Network', 'Cookies'),
    join(base, 'User Data', profile, 'Cookies'),
    join(base, profile, 'Cookies'),
    join(base, 'Default', 'Cookies'),
  ];
  const dbPath = candidates.find((p) => existsSync(p));
  if (!dbPath) throw new Error(`没找到 cookie 数据库，试过:\n${candidates.join('\n')}`);

  const password = await keychainPassword(def.keychainServices);
  if (!password) {
    throw new Error(`读不到钥匙串密码（${def.keychainServices.join(' / ')}）。首次运行会弹授权框，点允许。`);
  }
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');

  // The browser holds a lock on the live file.
  const tmp = mkdtempSync(join(tmpdir(), 'minote-cookies-'));
  const copy = join(tmp, 'Cookies');
  copyFileSync(dbPath, copy);

  try {
    const { stdout } = await execFileAsync(
      'sqlite3',
      ['-separator', '\u0001', copy, "select host_key, name, hex(encrypted_value) from cookies where host_key like '%mi.com' or host_key like '%xiaomi.com'"],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const out: Array<{ host: string; name: string; value: string }> = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [host, name, hex] = line.split('\u0001');
      if (!host || !name || !hex) continue;
      const value = decryptChromiumValue(Buffer.from(hex, 'hex'), key);
      if (value) out.push({ host, name, value });
    }
    return out;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --------------------------------------------------------------------------
// WebKit (Cookies.binarycookies)
// --------------------------------------------------------------------------

/**
 * Parse Apple's `Cookies.binarycookies`.
 *
 * Layout: "cook" magic, big-endian page count, big-endian page sizes, then the
 * pages. Each page is little-endian: magic \x00\x00\x01\x00, cookie count,
 * cookie offsets. Each cookie record holds four offsets (url, name, path,
 * value), a double expiry (seconds since 2001-01-01) and a flags word.
 */
export function parseBinaryCookies(data: Buffer): Array<{ host: string; name: string; value: string }> {
  if (data.length < 8 || data.subarray(0, 4).toString('binary') !== 'cook') {
    throw new Error('不是 binarycookies 格式');
  }

  const pageCount = data.readUInt32BE(4);
  const pageSizes: number[] = [];
  for (let i = 0; i < pageCount; i++) pageSizes.push(data.readUInt32BE(8 + 4 * i));

  const out: Array<{ host: string; name: string; value: string }> = [];
  let cursor = 8 + 4 * pageCount;

  for (const size of pageSizes) {
    const page = data.subarray(cursor, cursor + size);
    cursor += size;
    if (page.length < 8) continue;

    const count = page.readUInt32LE(4);
    const offsets: number[] = [];
    for (let i = 0; i < count; i++) {
      const at = 8 + 4 * i;
      if (at + 4 > page.length) break;
      offsets.push(page.readUInt32LE(at));
    }

    for (const off of offsets) {
      if (off + 4 > page.length) continue;
      const recordSize = page.readUInt32LE(off);
      const record = page.subarray(off, off + recordSize);
      if (record.length < 40) continue;

      const urlOff = record.readUInt32LE(16);
      const nameOff = record.readUInt32LE(20);
      const valueOff = record.readUInt32LE(28);

      const readStr = (start: number): string => {
        if (start <= 0 || start >= record.length) return '';
        const end = record.indexOf(0, start);
        if (end === -1) return '';
        return record.subarray(start, end).toString('utf8');
      };

      const host = readStr(urlOff).replace(/^\./, '');
      const name = readStr(nameOff);
      const value = readStr(valueOff);
      if (host && name && value) out.push({ host, name, value });
    }
  }

  return out;
}

function readWebKit(def: WebKitDef, storeId?: string): Array<{ host: string; name: string; value: string }> {
  const base = join(homedir(), 'Library', 'WebKit', def.bundleId, 'WebsiteDataStore');
  if (!existsSync(base)) throw new Error(`没找到 WebKit 数据目录: ${base}`);

  // Most recently modified store first — that's the one the browser is using.
  const cookiesFile = (d: string): string => join(base, d, 'Cookies', 'Cookies.binarycookies');
  const stores = storeId
    ? [storeId]
    : readdirSync(base)
        .filter((d) => existsSync(cookiesFile(d)))
        .sort((a, b) => statSync(cookiesFile(b)).mtimeMs - statSync(cookiesFile(a)).mtimeMs);

  const merged: Array<{ host: string; name: string; value: string }> = [];
  for (const store of stores) {
    const file = join(base, store, 'Cookies', 'Cookies.binarycookies');
    if (!existsSync(file)) continue;
    try {
      merged.push(...parseBinaryCookies(readFileSync(file)));
    } catch {
      // A corrupt store shouldn't abort the scan.
    }
  }
  return merged;
}

// --------------------------------------------------------------------------
// Assemble
// --------------------------------------------------------------------------

/** Group raw cookies into the service and account buckets. */
export function assemble(raw: Array<{ host: string; name: string; value: string }>): BrowserCookieResult {
  const hosts: Record<string, string[]> = {};
  const service = new Map<string, string>();
  const account = new Map<string, string>();

  for (const { host, name, value } of raw) {
    hosts[host] = hosts[host] ?? [];
    hosts[host].push(name);

    const bucket = bucketFor(host);
    if (bucket === 'account' && ACCOUNT_COOKIE_NAMES.has(name)) {
      account.set(name, value);
    } else if (bucket === 'service' && SERVICE_COOKIE_NAMES.has(name)) {
      service.set(name, value);
    }
  }

  // A bare `.mi.com` cookie store can hold `i.mi.com_ph`-style domain-prefixed
  // names; those belong to the service bucket only.
  const serviceCookie = [...service.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const accountCookie = [...account.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  return { serviceCookie, accountCookie, hosts };
}

export function platformSupported(): boolean {
  return process.platform === 'darwin';
}

export async function readBrowserCookies(
  browser: BrowserId,
  opts: { profile?: string; storeId?: string } = {},
): Promise<BrowserCookieResult> {
  if (!platformSupported()) {
    throw new Error(
      '从浏览器读 cookie 目前只支持 macOS（需要钥匙串 + WebKit 数据目录）。\n' +
        '其他系统请先 `npm run login -- --paste` 手动粘贴，或把服务端跑在 Mac 上。',
    );
  }
  const def = BROWSERS[browser];
  const raw =
    def.kind === 'chromium'
      ? await readChromium(def, opts.profile ?? 'Default')
      : readWebKit(def, opts.storeId);
  return assemble(raw);
}

/** Which browsers actually have Xiaomi cookies on this machine. */
export async function findCookieSources(): Promise<Array<{ browser: BrowserId; hosts: string[] }>> {
  if (!platformSupported()) return [];
  const found: Array<{ browser: BrowserId; hosts: string[] }> = [];
  for (const browser of Object.keys(BROWSERS) as BrowserId[]) {
    try {
      const result = await readBrowserCookies(browser);
      const hosts = Object.keys(result.hosts);
      if (hosts.length > 0) found.push({ browser, hosts });
    } catch {
      // Not installed / not readable — skip.
    }
  }
  return found;
}
