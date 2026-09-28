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
  auth.js               扫码登录（longPolling 协议）与静默续期
  client.js             i.mi.com 笔记 API（读 / 写 / 删除 / 文件夹）
  converter.js          小米自有 XML ↔ Markdown 双向转换
  repository.js         笔记仓库：增量同步、视图模型、检索打分
  store.js              凭据与缓存的原子持久化（插件数据目录，0600）
  service.js            业务编排：登录 / 同步 / 读写 / AI 问答 / 任务机制
renderer/index.html     主面板（列表 + 正文 + 扫码 + 编辑预览 + AI 问答）
views/sidebar.html      侧边栏视图（紧凑列表 + 内联阅读 + 复制全文）
skills/mi-note.md       注入给 Agent 的使用说明
```

开发工具在工作区根目录的 `tools/`（**不打包进插件**）：

```
tools/pack.js           打包（store-only ZIP）
tools/verify.js         校验产物（106 项）
tools/ui-harness/       浏览器里复现宿主窗口 chrome 的调试台
```

> **为什么工具不放在插件目录里**：`pack.js` 会打包插件目录下除 `.git` /
> `node_modules` / `dist` 外的**所有**文件，放进去会被打进安装包。

## 打包与校验

```bash
node tools/pack.js mi-note     # → mi-note/dist/pi.mi-note-<版本>.piplug
node tools/verify.js           # 校验产物（106 项）
```

`pack.js` 手写 ZIP 结构。**关键约束**：`.piplug` 必须是 store-only（不压缩）的 ZIP，
宿主安装器会拒绝 deflate 条目。

`verify.js` 做四类检查：

| 类别 | 内容 |
| --- | --- |
| 结构 | 文件数 ≤ 2000、体积 < 50 MB、全部 store-only |
| 内容 | 包内每个条目与源文件逐字节比对 |
| 回归 | 断言历史修复仍在（界面、自动保存、局部更新、删除撤销等） |
| 文档 | README / manifest 的描述与实现一致，开发文件没混进包 |

回归与文档两类是重点：把每个踩过的坑固化成断言，避免改代码时无声回归。

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

---

## 实现说明

### 为什么用原生 `node:http` 而不是 `pi.net.fetch`

宿主把响应头收进普通对象（`res.headers.forEach`），多个 `Set-Cookie` 会互相覆盖；
而小米扫码登录恰恰依赖「一次响应里的多个 Set-Cookie」建立会话。同理，登录涉及跨
`xiaomi.com` / `mi.com` 的 cookie 域匹配，需要一个真实的 cookie 罐。

### 为什么长任务走 job + 轮询

宿主转发面板通道调用的超时是 30 秒，而全量同步与模型问答都可能跑几分钟。所以
`mn.login.start` / `mn.sync.start` / `mn.ask` 都是立即返回 `jobId`，
由页面轮询 `mn.job.get` 取进度与结果。

### 为什么布局用纯 CSS 栅格

面板最初是「文件夹 + 列表 + 正文」三栏 + 可拖动分隔条。这套方案在无边框 Electron
窗口里迭代四轮仍不稳定：指针捕获失效、拖动死区、窗口缩放把宽度写死、编辑区硬约束
导致窄窗口下拖动完全冻结。

最终改成固定比例栅格：

```css
grid-template-columns: minmax(240px, min(300px, 42%)) minmax(0, 1fr);
```

**JS 完全不参与宽度计算**，整类问题从根上消失。
教训：能用 CSS 表达的布局就不要用 JS 算。

### 删除为什么用「延迟提交」

服务端没有「从回收站恢复」的接口，所以撤销不能靠删完再恢复。面板采用延迟提交：
乐观删除（加入 `state.pendingDelete` 并从列表隐藏）+ 6 秒撤销窗口，超时才真正提交。

两个必须的配套处理：

- 列表渲染要过滤 `pendingDelete`，否则 5 分钟自动同步把云端数据拉回来后，
  已删笔记会「复活」出现在列表里
- 待删笔记若正开着，要先清空编辑器

### 自动保存的并发与落盘

- **IME**：`compositionstart/end` 期间只更新内存，不触发保存
- **并发**：`saveInFlight` 复用同一个 Promise；保存期间用户继续输入则比对快照，
  不一致就再排一次自动保存
- **落盘**：`repository.updateNote` 原本每次都整份重写磁盘缓存，自动保存下会持续
  占盘。改为 10 秒合并窗口（`scheduleCacheWrite`），同步完成 / 删除 / 退出时立即落盘
- **关闭兜底**：`pagehide` + `visibilitychange` 尽力冲刷，失败方向选「本地未保存」而非报错

### 列表局部更新

`noteNodes: Map<id, entry>` + `createNoteNode` / `updateNoteNode` 分离，
`renderNotes` 用 `insertBefore(el, cursor)` 按序摆位（顺序没变则零 DOM 移动），
只写真正变化的文本。

**关键收益**：保存后不再 `await loadNotes()` 整份重拉，改用 `refreshNoteInList(note)`
单篇更新 —— 实测保存时 `notesList` 调用数为 0。否则每次自动保存都要重建最多 300 个节点。

### 提示条为什么要堆叠

所有提示曾经共用一个 DOM 元素，`toast()` 里的 `textContent = message` 会**连「撤销」
按钮一起抹掉**，但 6 秒计时器仍在跑 → 笔记照样被删且无法撤销（**丢数据**）。

现在用 `.toast-stack` 容器，每条提示是独立元素，最多 3 条共存。

### 切编辑/预览为什么不能无条件抓光标快照

`renderEditor` 是销毁重建。从预览切回编辑时页面上没有 textarea，
`captureEditorView()` 返回 `null`，**无条件赋值会把上一步存好的快照覆盖成 null**，
光标照样丢。必须只在 `state.mode === "edit"` 时抓。

---

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
