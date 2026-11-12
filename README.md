# minote-mcp

小米笔记（小米便签 / i.mi.com）的 MCP server。用 TypeScript 写，让 Claude、Cursor、Codex 这些 MCP 客户端直接读、搜、写你的小米笔记 —— 手机端还是原来那个 App，同步交给小米云，不用迁移。

```
Claude / Cursor ──MCP(stdio)──> minote-mcp ──HTTPS──> i.mi.com
                                      │
                                 进程内缓存（元数据 + 正文）
```

## 为什么是这个方案

小米笔记没有官方 API，但 i.mi.com 的 h5 页面背后有一套完整的 HTTP CRUD 接口。这个 server 把它包成了标准 MCP 工具。代价是接口非官方，小米改版可能会坏；收益是**你不需要换笔记软件**。

## 快速开始

```bash
npm install
npm run build

# 1) 导入 cookie（二选一）
npm run login             # 手动粘贴
npm run login -- --from dia    # 或者直接从本机浏览器 cookie 库读（macOS）

# 2) 体检
npm run doctor

# 3) 接到 MCP 客户端
```

### 关于登录

小米的登录接口有人机验证（`verify.sec.xiaomi.com`），**自动化登录走不通**，所以这个 server 不做登录，只接收 cookie。两条路：

**A. 直接从浏览器读（推荐）**

```bash
npm run login                 # 扫描所有浏览器，选最完整的那个
npm run login -- --list       # 只看哪些浏览器有小米 cookie
npm run login -- --from alma  # Alma 内置浏览器（WKWebView）
npm run login -- --from dia   # Dia
npm run login -- --from chrome / edge / arc / brave / safari
```

支持三种存储格式：

| 格式 | 谁用 | 怎么读 |
|---|---|---|
| Chromium 加密 SQLite | Chrome / Dia / Edge / Arc / Brave | 钥匙串取密钥 → AES-128-CBC 解密 |
| `Cookies.binarycookies` | **Alma 内置浏览器**、Safari | 直接解析二进制格式 |
| CDP | 运行中的 Chrome | 连上调协议读（含 HttpOnly） |

首次运行会弹系统授权框，点允许。

**重要**：cookie 是按**名字白名单**挑的。`.mi.com` 上还挂着一堆统计 cookie
（`_tt_enable_cookie`、`ttcsid`、`__lt__cid`），混进请求里会让 jar 看着不空但根本没有会话 ——
比明显为空更糟。

**B. 手动粘贴**

```bash
npm run login -- --paste
```

自动识别粘进来的是哪种 cookie：

- 含 `passToken` → 当作账号会话，首次请求会自己换出 i.mi.com 会话
- 含 `serviceToken` → 当作 i.mi.com 会话，直接用

所以**只要拿到 `passToken` 就够了**，不必等页面刷出完整会话。

**续期是能跑通的**（实测验证）。链路是：

```
GET /api/user/login           → loginUrl（带 i.mi.com 的 callback 签名）
GET loginUrl                  → 302 到 https://i.mi.com/sts?sign=...
GET /sts                      → Set-Cookie: serviceToken / i.mi.com_ph / i.mi.com_slh
```

关键点有三个，缺一个就失败：

1. **中间那跳必须带 `.xiaomi.com` 的账号 cookie**，不是 i.mi.com 的
2. 换到的 cookie 要**过滤成只留 i.mi.com 域**，否则账号会话会被顺手塞进服务 jar
3. 刷新过程走**临时 jar**，成功才提交 —— 小米会在中途下发 `Max-Age=0` 清 `serviceToken`，
   失败的刷新如果直接改活 jar，反而把还能用的会话弄死

另外 **没有账号 cookie 时干脆不尝试续期**：尝试本身就等于主动注销。

**只要有一个就能跑**：MCP server 启动时不强制要求两个都在。只有账号 cookie 也能起来 ——
第一次请求会先换一个 i.mi.com 会话（实测：把服务 cookie 置空，仅凭 `passToken`
启动，`note_stats` 正常返回）。

**两种 cookie 的区别**（都在配置里）：

| 字段 | 内容 | 作用 |
|---|---|---|
| `cookie` | `serviceToken` / `userId` / `i.mi.com_ph` | 实际读写笔记用的会话 |
| `accountCookie` | `.xiaomi.com` 的 `passToken` / `cUserId` | **续期用**。会话过期后自动换新的，不用重新登录 |

没有 `accountCookie` 也能用，但过期后就得重新跑 `login`。

## 客户端配置

**Claude Desktop**（`~/Library/Application Support/Claude/claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "minote": {
      "command": "node",
      "args": ["/绝对路径/minote-mcp/dist/index.js"],
      "env": { "MINOTE_ALLOW_WRITES": "1" }
    }
  }
}
```

**Cursor** 写在 `.cursor/mcp.json`；**Claude Code** 用 `claude mcp add`。指向 `dist/index.js` 即可。

不想把 cookie 落盘就用环境变量：

```json
"env": {
  "MINOTE_COOKIE": "serviceToken=...; userId=...; i.mi.com_ph=...",
  "MINOTE_ACCOUNT_COOKIE": "passToken=...; cUserId=...",
  "MINOTE_ALLOW_WRITES": "1"
}
```

## 工具

| 工具 | 作用 |
|---|---|
| `list_notes` | 列出笔记，可按文件夹名过滤、分页、强制刷新 |
| `get_note` | 读单条笔记全文（Markdown / 原始格式 / 纯文本） |
| `search_notes` | 关键词搜索，`deep=true` 时连正文一起搜 |
| `list_folders` | 文件夹列表 + 各自笔记数 |
| `note_stats` | 总数 / 文件夹数 / 最近修改 / 上次同步 |
| `create_note` | 新建（Markdown 正文，可指定文件夹、颜色） |
| `update_note` | 修改：`replace` / `append` / `prepend`，也可只改标题或移动文件夹 |
| `delete_note` | 移入回收站；`purge=true` 彻底删除 |
| `create_folder` | 新建文件夹 |

**写操作默认关闭。** 开启方式：配置里 `allowWrites: true`，或环境变量 `MINOTE_ALLOW_WRITES=1`。和 Joplin 官方 MCP 的策略一致。

## 配置项

`~/.config/minote-mcp/config.json`（权限 600）：

```json
{
  "cookie": "serviceToken=...; userId=...; i.mi.com_ph=...",
  "accountCookie": "passToken=...; cUserId=...",
  "userAgent": "Mozilla/5.0 (...) Chrome/131.0.0.0 Safari/537.36",
  "locale": "zh_CN",
  "allowWrites": false,
  "baseUrl": "https://i.mi.com"
}
```

环境变量优先级更高：`MINOTE_COOKIE`、`MINOTE_ACCOUNT_COOKIE`、`MINOTE_USER_AGENT`、`MINOTE_ALLOW_WRITES`、`MINOTE_BASE_URL`、`MINOTE_MCP_CONFIG_DIR`。

`baseUrl` 用于国际账号（`https://us.i.mi.com`）或指向本地 mock 测试。

## CLI

```bash
npm run login            # 导入 cookie（支持 --from dia/chrome/edge/arc/brave）
npm run doctor           # 连通性 + cookie 完整性 + 转换器往返自检
npm run dump -- -o ./notes --meta   # 全量导出为 Markdown（只读，不回写）
```

## 测试

```bash
npm run selftest          # 70 项：笔记格式 <-> Markdown 转换、元数据归一化
npm run test:integration  # 34 项：打本地 mock 的 i.mi.com（分页/XSRF/401 续期/CRUD/删除语义）
npm run test:mcp          # 27 项：真起 MCP stdio 会话，逐个 tools/call
npm test                  # 上面三个一起跑

npm run test:live         # 打真实账号，只读
npm run test:live -- --write   # 额外建一条测试笔记，验证往返后删掉
```

离线测试用的是**从真实接口抄下来的样本**（真实 id 长度、真实 note body、真实 extraInfo），所以回归测试坏了基本就代表线上坏了。

## 接口细节（都是踩过的坑）

**路径**

- `GET /note/full/page?syncTag=&limit=` — 列表，分页靠回传 `syncTag`，`lastPage` 为 true 停
- `GET /note/note/{id}/` — 单条，**末尾有斜杠**
- `POST /note/note` — 新建，`entry` 传 **JSON 字符串**
- `POST /note/note/{id}` — 修改，`entry` 传 **JSON 字符串**，必须带 `tag`
- `POST /note/full/{id}/delete` — `tag` + `purge`
- `POST /note/folder` / `POST /note/folder/{id}` / 删除复用 `/note/full/{id}/delete`

**请求**

- `Referer` 必须是 `https://i.mi.com/note/h5`
- **`X-XSRF-TOKEN` 只在 POST 上加**，值取 cookie 的 `i.mi.com_ph`。GET 带了反而容易出问题
- 写操作要带 `serviceToken`（就是 cookie 里那个）

**数据**

- **`tag` 每次写入都会变** —— 缓存里拿到的 tag 一旦被任何写操作改过就失效，再用会返回
  `51006 便签未被删除`。所以写之前必须重新读一次
- **硬删除需要两步** —— 直接 `purge=true` 会返回 200 + `{result:"error", code:51006}`；
  必须先进回收站（`purge=false`）再 purge
- **HTTP 200 也可能是失败** —— 错误体的判断方式是 `result === "error"` 或 `code !== 0`，
  不能只看状态码。早期版本就是因为没判这个，"删除了"实际什么都没发生
- **`id` / `tag` 是带引号的字符串**，比如 `"43970664610546496"` —— 它们超过 `Number.MAX_SAFE_INTEGER`，用数字解析会丢精度（变成 `...46500`）。内部一律按字符串处理
- **标题在 `extraInfo` 里**，是个 JSON 串：`{"title":"大理","note_content_type":"common"}`。`subject` 字段在现代笔记里基本都是空字符串
- 正文是**一行一个块**的自定义 XML：

```
<new-format/>                                  可选，前向兼容标记
<text indent="1">段落</text>
<text indent="1"><size>大标题</size></text>      h1
<text indent="1"><mid-size>中标题</mid-size></text>   h2
<text indent="1"><h3-size>小标题</h3-size></text>     h3
<bullet indent="1" />列表项                     标记 + 内容
<order indent="1" inputnumber="1" />有序项
<input type="checkbox" indent="1" checked="true" />待办
<quote>引用</quote>
<hr />
<img fileid="..." imgshow="0" imgdes="" />
<sound fileid="..." />
<a href="...">链接标题</a>
```

  行内只有 `<b> <i> <u> <delete> <background color="#rrggbbaa">`。空 `<text>` 元素就是空行。

**登录态续期**

`GET /api/user/login` → 拿到 account 登录 URL → 跳转 → `https://i.mi.com/sts?...` → Set-Cookie 拿到 `serviceToken` / `i.mi.com_ph` / `i.mi.com_slh`。

关键在于**中间那跳要用 `.xiaomi.com` 的账号 cookie**，不是 i.mi.com 的。所以配置里分两个字段存。401 时自动走一遍并回写配置。

## 已知限制

- 接口非官方，小米改版可能会坏。出问题先跑 `npm run doctor`
- **登录必须手动做一次**（人机验证没法自动化）。但有了 `accountCookie` 之后，日常不需要再登
- 图片只识别不下载，正文里以 `note-image://<fileId>` 出现；语音是 `note-audio://`
- 正文缓存只在进程内，重启后首次读取会重新拉
- 写回时正文会被重新序列化。**复杂排版（表格、手写、录音转文字）不保证原样保留，改之前先 `get_note` 读一遍**
- 没有 token 级权限控制：能读到 cookie 就能读写全部笔记

## 许可

MIT。

接口逆向参考了这几个项目，谢谢他们先趟坑：

- [m2self/mi-note](https://github.com/m2self/mi-note) — Rust 客户端，CRUD + STS 刷新思路
- [nogiszd/xiaomi-note-exporter](https://github.com/nogiszd/xiaomi-note-exporter) — Tauri 导出器
- [pot-code/micloud-note-export](https://github.com/pot-code/micloud-note-export) — 早期导出脚本

但**实际的接口路径、id 类型、标题位置、正文格式都已按线上实测重写**，与上述项目描述有出入的地方以实测为准（见上面「接口细节」）。
