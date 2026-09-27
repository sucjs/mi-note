# 小米笔记

把小米云笔记做成 PI-Desktop 里的一个图形化工作面板，并让 AI 直接读写你的笔记。
**笔记能力已内置在插件里，不需要单独配置任何 MCP 服务器。**

## 功能

- **扫一扫登录**：面板显示二维码，用小米手机「设置 → 小米账号 → 扫一扫」确认即可。
  不用输密码，不受图形验证码 / 两步验证影响。二维码 5 分钟有效，过期后点「重新获取」。
- **图形化界面**：左侧文件夹栏 + 中间笔记列表 + 右侧正文，深色 / 浅色随宿主主题切换。
- **笔记管理**：浏览、搜索（标题与正文）、新建、编辑（Markdown，带预览）、删除，
  按文件夹筛选。删除默认进回收站，可在小米笔记客户端恢复。
- **AI 问答**：基于你的笔记内容回答，走 PI-Desktop 已登录的模型（`pi.agent.complete`），
  插件拿不到任何 API 密钥。只把检索命中的片段送进上下文，不是全部笔记。
- **自动同步**：启动后每 5 分钟一次增量同步（`syncTag` + `modifyDate` 双重判定，
  只重取变化的正文）。凭据失效时用长效票据静默续期，无需手工复制 Cookie。
- **内置 Agent 工具**：10 个工具让 AI 直接操作笔记，见下表。
- **侧边栏视图**：右侧工作面板里的紧凑笔记列表（标题 + 修改时间 + 搜索）。
  点标题即在侧边栏内阅读全文；每项右侧按钮可在主面板中打开并定位到该篇；
  阅读界面顶部有「复制全文」，写入剪贴板便于粘到对话框。

## 登录

1. 打开面板（命令面板搜「小米笔记」，或从插件页打开）。
2. 面板显示二维码。
3. 用小米手机的「设置 → 小米账号 → 扫一扫」扫描，并在手机上确认。
4. 面板自动完成登录与首次同步。

扫码登录不需要密码，也不需要手动复制 Cookie。

## Agent 工具

| 工具 | 风险 | 用途 |
| --- | --- | --- |
| `list_folders` | low | 列出文件夹与各自的笔记数 |
| `list_notes` | low | 列出笔记（按文件夹筛选 / 关键词搜索 / 分页） |
| `read_note` | low | 读一篇的完整 Markdown 正文 |
| `search_notes` | low | 在标题与正文里搜关键词，返回命中片段 |
| `create_note` | medium | 新建笔记（正文用 Markdown） |
| `update_note` | medium | 改正文 / 标题 / 所属文件夹 |
| `delete_note` | high | 删除（默认进回收站） |
| `create_folder` | medium | 新建文件夹 |
| `sync_notes` | low | 立即同步 |
| `note_status` | low | 查登录状态、笔记数量、上次同步时间 |

## 开发

```bash
pnpm pi-plugin check .
pnpm pi-plugin pack .
# 生成 dist/pi.mi-note-0.1.0.piplug
```

从插件页安装 `.piplug`，或直接用「加载开发插件」指向本目录（保存即热重载）。

### 代码结构

```
main.js              插件入口：命令 / Agent 工具 / 面板通道 / 后台同步服务
lib/http.js          极简 HTTP 客户端 + Cookie 罐（含可中止请求）
lib/auth.js          扫码登录（longPolling 协议）与静默续期
lib/client.js        i.mi.com 笔记 API（读 / 写 / 删除 / 文件夹）
lib/converter.js     小米自有 XML ↔ Markdown 双向转换
lib/repository.js    笔记仓库：增量同步、视图模型、检索打分
lib/store.js         凭据与缓存的原子持久化（插件数据目录，0600）
lib/service.js       业务编排：登录 / 同步 / 读写 / AI 问答 / 任务机制
renderer/index.html  主面板（三栏 + 扫码 + 编辑预览 + AI 问答）
views/sidebar.html   侧边栏视图（紧凑列表 + 内联阅读 + 复制全文）
skills/mi-note.md    注入给 Agent 的使用说明
```

### 两个实现层面的说明

**为什么用原生 `node:http` 而不是 `pi.net.fetch`。**
宿主把响应头收进普通对象（`res.headers.forEach`），多个 `Set-Cookie` 会互相覆盖；
而小米扫码登录恰恰依赖「一次响应里的多个 Set-Cookie」建立会话。同理，登录涉及跨
`xiaomi.com` / `mi.com` 的 cookie 域匹配，需要一个真实的 cookie 罐。

**为什么长任务走 job + 轮询。**
宿主转发面板通道调用的超时是 30 秒，而全量同步与模型问答都可能跑几分钟。所以
`mn.login.start` / `mn.sync.start` / `mn.ask` 都是立即返回 `jobId`，由页面轮询
`mn.job.get` 取进度与结果。

## 权限

| 权限 | 用途 |
| --- | --- |
| `ui.panel` / `ui.view` | 主面板与侧边栏视图 |
| `agent.tool.register` | 注册上述 10 个工具 |
| `agent.prompt.inject` | 注入 `skills/mi-note.md` |
| `agent.complete` | AI 问答（模型由宿主代调，插件拿不到密钥） |
| `models.list` | 问答的模型下拉框 |
| `clipboard.write` | 侧边栏「复制全文」 |
| `background.service` | 每 5 分钟自动同步（面板关掉后仍需运行） |

**数据边界**：插件只与 `i.mi.com` / `account.xiaomi.com` 通信；本地只写插件自己的
数据目录（宿主分配）下的两个文件——`credentials.json`（凭据，0600）与
`notes-cache.json`（笔记缓存）。不读也不写你的工作区文件。
