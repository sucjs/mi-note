# 开发者文档

面向修改代码、打包与调试。使用说明见 [README.md](README.md)。

---

## 环境

只需要 Node.js。**无第三方依赖** —— 所有工具都是零依赖脚本。

## 目录

```
manifest.json           清单：权限、命令、视图、Agent 工具声明
main.js                 插件入口：命令 / Agent 工具 / 面板通道 / 后台同步服务
lib/
  http.js               极简 HTTP 客户端 + Cookie 罐（含可中止请求）
  auth.js               扫码登录（longPolling 协议）
  client.js             i.mi.com 笔记 API（读 / 写 / 删除 / 文件夹）
  converter.js          小米自有 XML ↔ Markdown 双向转换
  repository.js         笔记仓库：增量同步、视图模型、检索打分
  store.js              凭据与缓存的原子持久化（插件数据目录，0600）
  service.js            业务编排：登录 / 同步 / 读写 / AI 问答 / 任务机制
renderer/index.html     主面板（列表 + 正文 + 扫码 + 编辑预览 + 导入导出 + AI 问答）
renderer/lib/
  markdown.js           Markdown → HTML 渲染（markdown-it + KaTeX + hljs，两侧共用）
  editor.js             编辑器辅助：工具栏动作、列表续行、快捷键、撤销栈
  outline.js            大纲抽取、滚动联动、当前节高亮
  export.js             导出 Markdown / 自包含 HTML
  assets.js             **生成物**：内联的样式与字体（勿手改，见下）
  vendor/               随包离线的三方库（markdown-it / highlight.js / KaTeX）
views/sidebar.html      侧边栏视图（紧凑列表 + 内联阅读 + 复制全文）
skills/mi-note.md       注入给 Agent 的使用说明
```

开发工具在工作区根目录的 `tools/`（**不打包进插件**）：

```
tools/pack.js           打包（store-only ZIP）
tools/embed-assets.js   把导出要用的样式/字体内联成 renderer/lib/assets.js
tools/verify.js         校验产物
tools/ui-harness/       浏览器里复现宿主窗口 chrome 的调试台
  import.test.js           批量导入回归（标题解析 + 文件夹编排）
  offline-refresh.test.js  掉线误判回归（网络故障 vs 登录失效）
  auto-relogin.test.js     自动重登回归（重放入口链 / 单次重试 / 并发去重）
```

> **为什么工具不放在插件目录里**：`pack.js` 会打包插件目录下除 `.git` /
> `node_modules` / `dist` 外的**所有**文件，放进去会被打进安装包。

## 打包与校验

```bash
node tools/embed-assets.js     # 改了 vendor 样式/字体后必须先跑（见下）
node tools/pack.js mi-note     # → mi-note/dist/local.mi-note-<版本>.piplug
node tools/verify.js           # 校验产物（末尾打印通过 / 失败项数）
node tools/ui-harness/import.test.js           # 批量导入回归
node tools/ui-harness/offline-refresh.test.js  # 掉线误判回归
node tools/ui-harness/auto-relogin.test.js     # 自动重登回归
```

> 校验脚本**不写死项数**：断言会随修复增加，写死的数字必然漂移成假信息。

`pack.js` 手写 ZIP 结构。**关键约束**：`.piplug` 必须是 store-only（不压缩）的 ZIP，
宿主安装器会拒绝 deflate 条目。

### 为什么要单独跑 embed-assets.js

导出功能要生成「自包含 HTML」，得把 KaTeX 字体与两份 hljs 主题写进导出文件。
但面板窗口是 `file://` + `sandbox: true` + `webSecurity: true`（宿主没有加
`allow-file-access-from-files`），**脚本读不了同目录的 vendor 文件** —— XHR / fetch
会被拦掉，和 `<script type="module">` 被 CORS 拦掉是同一类问题。

所以这些内容只能在打包前「烧」进 `renderer/lib/assets.js`：

- 产物是**生成物**，不要手改；改样式请改 `vendor/`，然后重跑脚本
- 产物里带一个 vendor 内容指纹；`verify.js` 会复算并比对，
  **改了 vendor 却忘了重跑就会直接报错**（防止导出悄悄少了字体）
- 只内联 woff2（woff / ttf 是给老浏览器兜底的，白白多几百 KB）

`verify.js` 做四类检查：

| 类别 | 内容 |
| --- | --- |
| 结构 | 文件数 ≤ 2000、体积 < 50 MB、全部 store-only |
| 内容 | 包内每个条目与源文件逐字节比对 |
| 回归 | 断言历史修复仍在（界面、自动保存、局部更新、删除撤销、导出、批量导入等） |
| 文档 | README / manifest 的描述与实现一致，开发文件没混进包 |

回归与文档两类是重点：把每个踩过的坑固化成断言，避免改代码时无声回归。
其中「导出与导入不得引入 `fs.*` 权限」与「assets.js 指纹」两类断言尤其不能删 ——
它们守住的是对外承诺（不读写工作区文件）与构建产物不漂移。

## 调试：ui-harness

无边框 Electron 窗口的很多问题（窗口控制按钮不可见、指针事件被原生拖拽区吃掉）
**在普通浏览器里复现不出来**，因为宿主注入的窗口 chrome 只在真实插件面板里存在。

`tools/ui-harness/` 从宿主 `app.asar` 抽出真实的 preload chrome 代码，配上桩化的
`pluginBridge`，拼成自包含 HTML，就能在浏览器里用**宿主真实代码**渲染和测量。

```bash
cd tools/ui-harness
node build-capsule-panel.js      # → capsule-panel.html
python -m http.server 8765       # 起静态服务（file:// 会被安全策略挡）
```

| 脚本 | 场景 |
| --- | --- |
| `build-capsule-panel.js` | 常规面板 + 真实 chrome + 对比度探针 |
| `build-capsule-race.js` | 主题竞态（宿主主题与系统偏好相反） |
| `build-capsule-inverted.js` | 极端撞色（深色宿主 + 浅色系统偏好） |

`build-host-chrome.js` 需要宿主 preload 路径（**自动生成 `host-chrome.js`，勿手改**）：

```bash
PI_HOST_PRELOAD=<path>/preload/plugin-panel.js node build-host-chrome.js
```

### 两个必须注意的坑

**1. 外部脚本会被缓存。** 构建脚本把 `stub.js` 等**内联**进产物，而不是 `<script src>`。
用外部脚本时，改了桩却还在跑旧代码，测试会给出**假通过**（踩过）。

**2. 拖拽/命中类问题必须用真实鼠标。** 合成 `PointerEvent` 会绕过原生命中测试，
给出假阳性。集成浏览器里页面常是 `hidden` 状态，需先开 CDP 焦点模拟：

```js
await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
```

## 其它约定

- **不要用 PowerShell 写 JS 文件**（5.1 会加 BOM，破坏脚本）。用 Node 生成。
- **构建产物容易和源码漂移**。`dist/*.piplug` 与 `ui-harness/*.html` 都是产物，
  改完源码务必重新生成，否则测的是旧代码。
- **每次小修都推进版本末位（`+0.0.1`）**。理由：`dist/*.piplug` 的文件名带版本号，
  版本不动就会反复覆盖同一个文件，用户无法判断手里的是哪一版、也无法区分「改了」与「没改」。
  版本号只写在 `manifest.json` 的 `version`，别处一律不得硬编码
  （`main.js` 从清单读，面板经 `mn.ping` 回填；`verify.js` 断言的是「格式合法」与
  「CHANGELOG 首节 == 清单版本」，而不是某个具体值）。
  改版本时必须同步做三件事：
  1. `manifest.json` 的 `version`
  2. `CHANGELOG.md` 顶部加同号小节（`verify.js` 会校验两者一致）
  3. `node tools/pack.js mi-note` 重新打包（否则 `dist/` 里留着旧版本名的文件）


## 登录与自动重登

登录态是一张 `serviceToken` 会话 Cookie（无 `expires`），实测寿命约 40 分钟。
**浏览器里「登录不会掉」靠的不是这张票本身**，而是它失效后能自动换一张新的 ——
插件走同一条路：

```
GET  https://i.mi.com/api/user/login        # 问登录入口
  →  302 https://account.xiaomi.com/pass/serviceLogin?…
  →  带 .xiaomi.com 域的 passToken / cUserId 时，服务端 302 回 i.mi.com
     并在 Set-Cookie 里种下新的 serviceToken
```

实现分布在四处，改动时**必须一起看**：

| 位置 | 职责 |
| --- | --- |
| `auth.followLoginEntry` | 走完上面这条跳转链（扫码与重登**共用**，不另写一份） |
| `auth.resolveServiceSession` | 用已存 Cookie 罐重放该链换新票；判据只看「罐里有没有新 `serviceToken`」 |
| `client.relogin` / `send` | 401 → 重登一次 → 用新凭据重试原请求 |
| `repository.relogin` / `ensureSession` | 落盘新凭据、登出优先保护、探活失败时先重登 |

三条**不可简化**的约束（各有回归测试钉住）：

1. **只重试一次** —— `allowRelogin` 开关。去掉就会「401 → 重登 → 又 401」无限循环。
2. **并发去重** —— 复用进行中的 promise。同步一轮几十个请求会同时拿到 401，
   不去重就会打出一串并发登录请求（易触发风控），且后完成的会覆盖新凭据。
3. **网络故障绝不判失效** —— 掉线时重登请求本身必然失败；
   误判会让完好的凭据被当成过期，逼用户白重扫一次码。

> ⚠️ **别把 0.2.6 的结论当成最终结论**。0.2.6 曾判定「换票走不通」并删掉整条续期，
> 原因是测了 `pass/serviceLogin?_json=true` 这个**网页交互式**端点 ——
> 它无人交互时只返回验证挑战（`notificationUrl` / `captchaUrl` / `pwd` /
> `securityStatus`），只给 `psecurity` 不给 `ssecurity`。那是**错的端点**，
> 浏览器并不走它。这段结论留在 `lib/auth.js` 顶部注释里，`verify.js` 会断言它还在。

**不做**基于 `ssecurity` 的签名交换：证据不足、易被风控，且不是浏览器的主路径。

## 权限与数据边界

| 权限 | 用途 |
| --- | --- |
| `ui.panel` / `ui.view` | 主面板与侧边栏视图 |
| `agent.tool.register` | 注册 10 个工具 |
| `agent.prompt.inject` | 注入 `skills/mi-note.md` |
| `agent.complete` | AI 问答（模型由宿主代调，插件拿不到密钥） |
| `models.list` | 问答的模型下拉框 |
| `clipboard.write` | 侧边栏「复制全文」 |
| `background.service` | 每 5 分钟自动同步（面板关掉后仍需运行） |

**数据边界**：插件只与 `i.mi.com` / `account.xiaomi.com` 通信；本地只写插件自己的
数据目录（宿主分配）下的两个文件——`credentials.json`（凭据，权限 0600）与
`notes-cache.json`（笔记缓存）。不读也不写工作区文件。

## Agent 工具清单

| 工具 | 风险 | 用途 |
| --- | --- | --- |
| `list_folders` | low | 列出文件夹与各自的笔记数 |
| `list_notes` | low | 列出笔记（按文件夹筛选 / 关键词搜索 / 分页） |
| `read_note` | low | 读一篇的完整 Markdown 正文 |
| `search_notes` | low | 在标题与正文里搜关键词，返回命中片段 |
| `create_note` | medium | 新建笔记（正文用 Markdown） |
| `update_note` | medium | 改正文 / 标题 / 所属文件夹 |
| `delete_note` | high | 删除（默认进回收站，可传 `purge: true` 彻底删除） |
| `create_folder` | medium | 新建文件夹 |
| `sync_notes` | low | 立即同步 |
| `note_status` | low | 查登录状态、笔记数量、上次同步时间 |

> 注意 `delete_note` 的「默认进回收站」与面板的删除是**两条独立路径**：
> 面板走「延迟提交 + 撤销」，Agent 工具保留回收站语义。
