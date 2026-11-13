<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.jpg">
  <img alt="Kojoo Mail：所有邮箱，一个收件箱" src="docs/images/hero-light.jpg">
</picture>

<p align="center">
  <b>简体中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/ekoouu/kojoomail/releases/latest"><b>下载</b></a> ·
  <a href="#能做什么">功能</a> ·
  <a href="#隐私">隐私</a> ·
  <a href="#从源码编译">从源码编译</a>
</p>

<p align="center">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-1B4A80?style=flat-square">
  <img alt="macOS 11+" src="https://img.shields.io/badge/macOS-11%2B%20·%20Apple%20芯片%20%2F%20Intel-1B1712?style=flat-square">
  <img alt="License AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-C63E1F?style=flat-square">
  <img alt="Tauri 2 + Rust" src="https://img.shields.io/badge/Tauri%202-Rust%20%2B%20React-6B5F4E?style=flat-square">
</p>

---

每天在 QQ 邮箱、公司邮箱、Gmail、Outlook 之间来回切，重要的询盘被通知和广告淹掉，回一封英文邮件要先翻译再斟酌——**Kojoo Mail 把这些合到一个窗口里**：所有账号的邮件按时间排在一起，AI 先帮你读一遍，告诉你哪封要紧、要做什么、可以怎么回。

它是一个桌面软件，邮件只存在你自己的电脑上。AI 用你自己的密钥，不经过我们的服务器。界面有中文和英文，默认跟随系统语言，可以在「设置 → 通用」里切换。

## 能做什么

### 一个收件箱，装下所有邮箱

QQ、网易 163/126、Gmail、Outlook、iCloud、企业邮箱和任何支持 IMAP 的邮箱。所有账号按时间排在一起，每个账号一个颜色；回信时自动用收信的那个身份发出，不会用错邮箱。

Gmail 和 Outlook 支持**一键登录**（浏览器里授权，不用填密码）。软件默认跟随系统代理连接邮件服务器，国内用 Gmail 不用开全局；系统代理不稳定时，也可以在「设置 → 通用 → 代理」里自己填代理地址，或者选不用代理。

### AI 批注：打开之前就知道这封信要干嘛

<img alt="AI 批注" src="docs/images/feature-ai.jpg">

每封新邮件都会被 AI 读一遍，在信的上方写一段批注：

- **一句话摘要**和分类：询盘、待办、账单、通知、订阅、个人
- **要点卡片**：数量、价格、贸易条款、付款方式、截止日期，一眼看全，不用在长邮件里找
- **待办**：信里要你做的事自动列出来，带截止日期
- **建议回复**：按来信的语言起草（英文信回英文），点「填入回复」直接改
- **邮件翻译**：点正文上方的「翻译成中文」，原有排版和链接保留，可随时切回原文；只在你点的时候翻，译文有缓存

通知和广告邮件用本地规则分类，不调用模型，不花你的钱。

### 今日简报：早上打开，一页看完

<img alt="今日简报" src="docs/images/feature-digest.jpg">

今天要回的、要付的、要跟进的，加上一段 AI 写的概要。出差回来几百封未读，先看这一页就知道从哪里下手。

### 写信：AI 起草，你来决定

<img alt="写信和 AI 助手" src="docs/images/feature-compose.jpg">

- 换个语气（专业 / 友好 / 简洁）重写，润色、翻译、缩短一半
- **要点核对**：对照来信的要点，检查回复有没有漏掉数量、条款、日期
- 支持 Markdown，发送时自动排版；点发送后几秒内可以撤销
- **AI 只起草，从不替你发信**

### 待办：从邮件里来，回到邮件里去

<img alt="待办" src="docs/images/feature-todo.jpg">

AI 从邮件里提出来的待办和你自己加的放在一起，按今天、本周、以后排好。点一下就跳回那封邮件处理。

### 还有这些

| | |
|---|---|
| **重点** | 你标的星标，加上 AI 判断需要尽快处理的 |
| **待跟进** | 你发出去 3 天以上、对方还没回的邮件 |
| **账单发票** | 各账号的账单、发票、扣费提醒合在一起 |
| **稍后处理** | 把邮件暂时收起来，到点再出现 |
| **会话视图** | 同一来回的邮件在列表里合成一行，点开按时间看整串；回复、归档、删除仍只针对单封（默认关闭，在「设置 → 通用」打开） |
| **邮件规则** | 新邮件到达收件箱时，按发件人、收件人、主题、有没有附件自动移动到文件夹、归档、移到垃圾邮件、标为已读或重点；规则在本机执行，不会删除邮件，也不会自动发信 |
| **验证码** | 收到验证码邮件时，通知里直接显示验证码，打开邮件可一键复制；本机识别，不经过 AI |
| **问邮箱** | 在搜索框里直接提问，比如「上次给 Marco 报的价是多少？」，AI 从你的邮件里找答案并标出处 |
| **深色模式** | 跟随系统，或者手动切换；Windows 11 上有磨砂玻璃效果 |
| **键盘操作** | `J` `K` 上下、`E` 归档、`R` 回复、`C` 写信、`Ctrl K` 搜索 |

<img alt="深色模式" src="docs/images/feature-dark.jpg">

### 省资源

安装包：Windows 约 3 MB，macOS 约 10 MB。界面用系统自带的网页组件显示，不在安装包里另带一个浏览器。

每个账号只保持一条连接，有新邮件时由服务器推送过来，软件不会反复去查。空闲时 CPU 几乎为零。关掉窗口会缩到托盘，后台照常收信，界面占的内存同时让系统收回。

Windows 任务管理器里的内存（作者日常使用，Windows 11，2026 年 11 月实测）：

| | 内存 |
|---|---|
| 主程序 `kojoomail.exe`（收信、AI、本地数据库） | 20～30 MB（刚启动约 20 MB，连开一整天约 30 MB） |
| 加上界面进程（任务管理器里显示为 Microsoft Edge WebView2），窗口开着 | 约 110 MB |
| 加上界面进程，缩到托盘后 | 约 40 MB |

## 隐私

- 邮件、设置、待办**只存在你的电脑上**；密码、登录授权、AI 密钥存在系统的凭据管理器（Windows 凭据管理器 / macOS 钥匙串）
- 软件只连接：你的邮件服务器、一键登录时谷歌 / 微软的登录服务、**你自己配置的 AI 接口**、检查更新的地址
- 没有账号体系，没有统计，没有广告
- 可以按账号关掉 AI：这个账号的邮件一封都不会发给模型
- 详见 [隐私政策](https://mail.songxxai.com/kojoomail/privacy)

## AI 怎么配

在「设置 → AI 与模型」选一个服务商，填上你自己的密钥就能用。任何兼容 OpenAI 接口的服务都可以：DeepSeek、通义千问、Kimi、OpenAI 有现成选项，其他兼容接口（包括你自己部署的模型）填地址就行。每天有分析上限，可以自己调。

在「自定义要求」里可以写下你的偏好，比如回复的语气、称呼、更关注哪类信息，AI 写批注、起草回复和跟进邮件时会参考。

不配 AI 也能用：它就是一个干净、省资源的多账号邮件客户端。

### 给你自己的 AI Agent 用（MCP）

在「设置 → AI 与模型 → 外部 AI Agent（MCP）」打开开关，把页面上的配置片段复制进 Claude Desktop、Cursor 这类 Agent 的 MCP 配置，Agent 就能搜索、读取这台电脑上已同步的邮件和 AI 批注。

- **只读**：不能发信、删除或移动邮件
- **默认关闭**；关了「允许发给 AI」的邮箱，Agent 也读不到

## 下载

到 **[Releases](https://github.com/ekoouu/kojoomail/releases/latest)** 下载最新版：

| 系统 | 文件 |
|---|---|
| Windows 10/11（64 位） | `KojooMail_版本号_x64-setup.exe` |
| macOS 11 及以上（Apple 芯片和 Intel 芯片通用） | `KojooMail_版本号_universal.dmg` |

软件有新版本时会提示你，点一下就能更新。

> macOS 版暂时没有苹果开发者签名，第一次打开要去「系统设置 → 隐私与安全性」点「仍要打开」。
> Windows 版暂时没有代码签名，安装时如果弹出「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」。

## 从源码编译

需要 Node.js 20+、Rust（stable）和 [Tauri 2 的系统依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
npm ci
npm run tauri dev                  # 开发模式
bash scripts/build-installer.sh    # Windows 安装包
bash scripts/build-mac.sh          # macOS（在 Mac 上跑）
```

- Gmail / Outlook 一键登录需要你自己申请客户端 ID，见 [docs/oauth-setup.md](docs/oauth-setup.md)；不申请也能编译，Gmail 用应用专用密码登录
- **自己改代码再分发的话**：把 `src-tauri/tauri.conf.json` 里 `plugins.updater` 的 `pubkey` 和 `endpoints` 换成你自己的（`tauri signer generate` 生成密钥），或者删掉这一段，否则你的版本会提示用户更新到官方版
- README 里的截图用演示数据生成：`scripts/screenshots/`

| 目录 | 内容 |
|---|---|
| `src/` | 界面（React + TypeScript） |
| `src-tauri/` | 后端（Rust）：IMAP/SMTP、同步、AI 队列、本地数据库 |
| `design/` | 图标源文件 |
| `docs/` | 说明文档和 README 用图 |
| `tests/` | 单元测试和端到端测试 |
| `scripts/` | 构建、图标、截图脚本 |

## 参与

欢迎提 Issue 和 Pull Request。提交前请看 [CONTRIBUTING.md](CONTRIBUTING.md)。

接下来打算做什么、哪些已经在做，见 [路线图](https://github.com/ekoouu/kojoomail/issues/6)。每一版改了什么，见 [Releases](https://github.com/ekoouu/kojoomail/releases)。

## 致谢

感谢 [LINUX DO](https://linux.do) 社区，项目最早在这里分享和收集反馈。

感谢贡献代码的朋友：[@Birdy0109](https://github.com/Birdy0109)。

## 许可证

[GNU AGPL-3.0](LICENSE)。你可以免费使用、修改和分发；分发修改后的版本（包括做成网络服务给别人用）时，也必须按 AGPL 公开源码。需要闭源使用或商业授权，请联系 eko@kojoo.co。

