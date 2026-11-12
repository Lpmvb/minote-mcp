#!/usr/bin/env node
/**
 * Cookie setup.
 *
 * We deliberately do NOT automate the Xiaomi login form. Xiaomi gates logins
 * behind `verify.sec.xiaomi.com` (captcha / device verification) and 2FA, and
 * automating it would mean handling the user's password. Instead this reads the
 * cookie out of a browser that is ALREADY logged in.
 *
 *   npm run login                      # scan every browser, pick the freshest
 *   npm run login -- --from alma       # Alma 的内置浏览器 (WKWebView)
 *   npm run login -- --from dia        # Dia
 *   npm run login -- --from chrome
 *   npm run login -- --list            # 只列出哪些浏览器有小米 cookie
 *   npm run login -- --paste           # 手动粘贴
 *
 * Two cookies are collected because they serve different purposes:
 *   serviceCookie — i.mi.com session, used for every API call
 *   accountCookie — .xiaomi.com account session, used to mint a NEW i.mi.com
 *                   session when the old one expires
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { configPath, inspectCookie, loadConfig, saveConfig } from '../config.js';
import { MiNoteClient } from '../micloud/client.js';
import { findCookieSources, platformSupported, readBrowserCookies, type BrowserId } from './browser-cookies.js';

const HOWTO = `
手动粘贴 cookie
────────────────────────────────────────────
1. 浏览器打开 https://i.mi.com/note/h5 并登录（要真的进到笔记页面）
2. 开发者工具 → Network → 点任意 i.mi.com 请求 → 复制 Request Headers 里的 Cookie
3. 粘贴到下面。完整的话里面会有 serviceToken / userId / i.mi.com_ph
`;

const VALID_BROWSERS: BrowserId[] = ['alma', 'dia', 'chrome', 'edge', 'arc', 'brave', 'safari'];

interface Args {
  from?: BrowserId;
  profile?: string;
  storeId?: string;
  list: boolean;
  paste: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { list: false, paste: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') {
      const v = argv[++i];
      if (v && (VALID_BROWSERS as string[]).includes(v)) args.from = v as BrowserId;
    } else if (a === '--profile') {
      args.profile = argv[++i];
    } else if (a === '--store') {
      args.storeId = argv[++i];
    } else if (a === '--list') {
      args.list = true;
    } else if (a === '--paste') {
      args.paste = true;
    }
  }
  return args;
}

interface Candidate {
  /** Where it came from — a browser id, or 'paste'. */
  source: string;
  serviceCookie: string;
  accountCookie: string;
}

/**
 * A service cookie is only usable if it has a serviceToken. An account cookie
 * is only usable if it has a passToken.
 */
function usableService(cookie: string): boolean {
  return /\bserviceToken=[^;\s]+/.test(cookie);
}

function usableAccount(cookie: string): boolean {
  return /\bpassToken=[^;\s]+/.test(cookie);
}

async function collect(args: Args): Promise<Candidate | null> {
  if (args.from) {
    const read = await readBrowserCookies(args.from, {
      ...(args.profile ? { profile: args.profile } : {}),
      ...(args.storeId ? { storeId: args.storeId } : {}),
    });
    if (!usableService(read.serviceCookie) && !usableAccount(read.accountCookie)) {
      stdout.write(`⚠️  ${args.from} 里没有小米 cookie\n`);
      return null;
    }
    return {
      source: args.from,
      serviceCookie: read.serviceCookie,
      accountCookie: read.accountCookie,
    };
  }

  if (!platformSupported()) {
    stdout.write(`当前系统是 ${process.platform}，自动读取浏览器 cookie 只支持 macOS。\n`);
    stdout.write('用 `npm run login -- --paste` 手动粘贴，或者把 server 跑在 Mac 上。\n');
    return null;
  }

  // No --from: scan everything and take the best combination.
  stdout.write('扫描本机浏览器的 cookie…\n');
  const sources = await findCookieSources();
  if (sources.length === 0) {
    stdout.write('没找到任何含小米 cookie 的浏览器。先在浏览器里登录 https://i.mi.com/note/h5，\n');
    stdout.write('或者用 `npm run login -- --paste` 手动粘贴。\n');
    return null;
  }

  for (const s of sources) {
    stdout.write(`  ${s.browser}: ${s.hosts.join(', ')}\n`);
  }

  let best: Candidate | null = null;
  for (const s of sources) {
    try {
      const read = await readBrowserCookies(s.browser);
      const candidate: Candidate = {
        source: s.browser,
        serviceCookie: read.serviceCookie,
        accountCookie: read.accountCookie,
      };
      // Prefer a candidate that can actually talk to the API, then one that can refresh.
      const score =
        (usableService(candidate.serviceCookie) ? 4 : 0) + (usableAccount(candidate.accountCookie) ? 2 : 0);
      const bestScore = best
        ? (usableService(best.serviceCookie) ? 4 : 0) + (usableAccount(best.accountCookie) ? 2 : 0)
        : -1;
      if (score > bestScore) best = candidate;
    } catch {
      // Skip unreadable stores.
    }
  }
  return best;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  if (args.list) {
    if (!platformSupported()) {
      stdout.write(`自动读取浏览器 cookie 只支持 macOS（当前 ${process.platform}）。\n`);
      return;
    }
    const sources = await findCookieSources();
    if (sources.length === 0) {
      stdout.write('没有找到含小米 cookie 的浏览器。\n');
    } else {
      for (const s of sources) stdout.write(`${s.browser}: ${s.hosts.join(', ')}\n`);
    }
    return;
  }

  let candidate = args.paste ? null : await collect(args);

  if (!candidate) {
    stdout.write(HOWTO);
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      const pasted = (await rl.question('\ni.mi.com cookie> ')).trim().replace(/^cookie:\s*/i, '');
      if (!pasted) {
        stdout.write('没有输入，已取消。\n');
        process.exit(1);
      }

      // A pasted blob can be either kind. Detect instead of asking the user to
      // know the difference: passToken means account session, serviceToken
      // means i.mi.com session.
      const looksAccount = /\bpassToken=/.test(pasted) && !/\bserviceToken=/.test(pasted);
      candidate = looksAccount
        ? { source: 'paste', serviceCookie: '', accountCookie: pasted }
        : { source: 'paste', serviceCookie: pasted, accountCookie: '' };

      if (looksAccount) {
        stdout.write('  识别为账号 cookie（passToken）—— 首次请求会自动换出 i.mi.com 会话\n');
      }
    } finally {
      rl.close();
    }
  }

  const service = candidate.serviceCookie;
  const account = candidate.accountCookie || cfg.accountCookie;

  const info = inspectCookie(service);
  stdout.write(`\n来自 ${candidate.source}\n`);
  stdout.write(`i.mi.com 会话: ${info.names.length ? info.names.join(', ') : '（空）'}\n`);
  stdout.write(`  serviceToken: ${info.hasServiceToken ? '✅' : '❌'}\n`);
  stdout.write(`  userId:       ${info.hasUserId ? '✅' : '❌'}\n`);
  stdout.write(`  i.mi.com_ph:  ${info.hasPh ? '✅' : '❌  （缺了写操作会被 XSRF 拦）'}\n`);
  stdout.write(`账号会话: ${usableAccount(account) ? '✅ 有 passToken，过期能自动续' : '❌ 没有，过期需重新 login'}\n`);

  stdout.write('\n验证中…\n');

  // Track whatever cookie the client ends up using — a refresh during this
  // check mints a fresh session, and that is the one worth saving. Persisting
  // the *original* (possibly stale) string here is how you end up writing a
  // config that cannot talk to the API.
  let effective = service;
  const client = new MiNoteClient({
    cookie: service,
    accountCookie: account,
    userAgent: cfg.userAgent,
    onCookieRefresh: (c) => {
      stdout.write('  🔄 用账号 cookie 换到了新会话\n');
      effective = c;
    },
  });

  try {
    const page = await client.listPage(1);
    const names = inspectCookie(effective).names;
    stdout.write(`✅ 连接成功，首页返回 ${page.entries?.length ?? 0} 条笔记\n`);
    stdout.write(`   实际使用的会话: ${names.join(', ') || '（不完整）'}\n`);
  } catch (e) {
    stdout.write(`❌ 读取失败: ${(e as Error).message}\n`);
    if (!usableAccount(account)) {
      stdout.write('\n没有账号 cookie，无法自动续期。\n');
      stdout.write('解决办法：在浏览器里打开一次 https://i.mi.com/note/h5 让会话刷新，再跑一次 login。\n');
    } else {
      stdout.write('\n账号 cookie 在但没有换到新会话 —— 可能已被服务端作废。\n');
      stdout.write('在浏览器里重新登录一次 https://i.mi.com/note/h5，再跑 login。\n');
    }
    process.exit(1);
  }

  const finalInfo = inspectCookie(effective);
  saveConfig({
    cookie: effective,
    ...(usableAccount(account) ? { accountCookie: account } : {}),
  });
  stdout.write(`\n已写入 ${configPath()}\n`);
  if (!finalInfo.hasServiceToken) {
    stdout.write('⚠️  保存的会话看起来不完整，但刚才的请求成功了，可能是短期会话。\n');
  }
  stdout.write('下一步：把 dist/index.js 配到 MCP 客户端（见 README）。\n');
}

main().catch((e: unknown) => {
  stdout.write(`出错: ${(e as Error).message}\n`);
  process.exit(1);
});
