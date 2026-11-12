import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  /**
   * i.mi.com session cookie: serviceToken + userId + i.mi.com_ph.
   * Enough to read/write until it expires.
   */
  cookie: z.string().default(''),
  /**
   * Account-level cookie on `.xiaomi.com` (passToken, cUserId, passport_ph…).
   * Needed to *mint a new* i.mi.com session without the user re-copying by hand.
   * Without it the server still works, but once `cookie` expires you must run
   * `npm run login` again.
   */
  accountCookie: z.string().default(''),
  /** User-Agent to impersonate; Xiaomi ties the STS session to it fairly loosely. */
  userAgent: z
    .string()
    .default(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ),
  locale: z.string().default('zh_CN'),
  /** Allow mutating tools (create/update/delete). Off by default — same policy as Joplin's MCP. */
  allowWrites: z.boolean().default(false),
  /** API host. Override for regional accounts (e.g. https://us.i.mi.com) or local testing. */
  baseUrl: z.string().default('https://i.mi.com'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  const base = process.env.MINOTE_MCP_CONFIG_DIR ?? join(homedir(), '.config', 'minote-mcp');
  return join(base, 'config.json');
}

export function loadConfig(): Config {
  const path = configPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  }

  // Env vars win, so the server can run head-less without writing secrets to disk.
  if (process.env.MINOTE_COOKIE) raw.cookie = process.env.MINOTE_COOKIE;
  if (process.env.MINOTE_ACCOUNT_COOKIE) raw.accountCookie = process.env.MINOTE_ACCOUNT_COOKIE;
  if (process.env.MINOTE_USER_AGENT) raw.userAgent = process.env.MINOTE_USER_AGENT;
  if (process.env.MINOTE_ALLOW_WRITES) raw.allowWrites = process.env.MINOTE_ALLOW_WRITES === '1';
  if (process.env.MINOTE_BASE_URL) raw.baseUrl = process.env.MINOTE_BASE_URL;

  return ConfigSchema.parse(raw);
}

export function saveConfig(patch: Partial<Config>): Config {
  const path = configPath();
  const current = loadConfig();
  const next = ConfigSchema.parse({ ...current, ...patch });
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort — Windows / exotic filesystems
  }
  return next;
}

/** Minimum viable cookie: serviceToken is needed for writes, userId identifies the account. */
export function inspectCookie(cookie: string): {
  ok: boolean;
  hasServiceToken: boolean;
  hasUserId: boolean;
  hasSlh: boolean;
  hasPh: boolean;
  names: string[];
} {
  const names: string[] = [];
  const map = new Map<string, string>();
  for (const part of cookie.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    map.set(k, v);
    names.push(k);
  }
  const has = (k: string): boolean => (map.get(k) ?? '').length > 0;
  return {
    ok: has('serviceToken') && has('userId'),
    hasServiceToken: has('serviceToken'),
    hasUserId: has('userId'),
    hasSlh: has('i.mi.com_slh') || has('slh'),
    hasPh: has('i.mi.com_ph') || has('ph'),
    names,
  };
}
