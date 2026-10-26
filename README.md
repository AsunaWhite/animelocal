# 本季番剧库 · AnimeLocal

管理本地动画视频的 Windows 桌面应用。自动拉取当季新番清单，识别你硬盘上的资源属于哪一部第几集，一键用默认播放器打开，每集还能记吐槽。

## 跑起来

```powershell
npm install      # 第一次才需要
npm start        # 启动
npm run dev      # 启动 + 自动开 DevTools
npm run shot     # 截图到 .dev/shot.png（验证界面用，截完自动退出）
npm test         # 离线跑全部测试（解析 + 别名 + 本地库 + 集数识别，都不联网）
node scripts/test-catalog.js --live   # 联网抓当季，验证缓存
```

> Electron 的 stdout/stderr 一旦接进 PowerShell 管道就会崩（`crashpad not connected`），所以 `scripts/launch.js` 把子进程输出重定向到 `.dev/electron.log`，退出时再把日志尾巴打印出来。

## 目录结构

```
src/
  main/main.js        主进程：开窗口、IPC
  main/catalog.js     抓 yuc.wiki + 解析 + 封面缓存（纯 Node，可单独测试）
  main/romaji.js      用日文原名去 AniList 换罗马音别名（纯 Node，可单独测试）
  main/library.js     勾选记录 + 别名记忆，原子写 JSON（纯 Node，可单独测试）
  main/scanner.js     扫本地目录、认作品、抠集数（纯 Node，可单独测试）
  preload/preload.js  桥：只把白名单能力暴露给界面
  renderer/           界面：HTML + CSS + 原生 JS，没有框架、没有打包
    index.html
    style.css
    app.js
scripts/
  launch.js           启动器：清掉 ELECTRON_RUN_AS_NODE、重定向日志
  test-catalog.js     解析测试
  test-romaji.js      别名匹配测试（假请求，不联网）
  test-library.js     勾选记录测试
  test-scanner.js     集数识别 + 标题匹配 + 真扫目录测试
test/fixtures/        202610 季度页快照 + 旧 Python 版的解析结果（对答案基准）
```

**为什么分三层**：主进程有系统权限（能删你的文件），界面层跑的是网页代码。中间隔一道 preload 白名单，界面就只能做你允许它做的事。这是 Electron 的基本安全模型。

## 数据来源

- 动画清单 + 封面 + 日文原名：<https://yuc.wiki/>（季度号形如 `202610`，1/4/7/10 月）
- 罗马音别名：<https://graphql.anilist.co>（用日文原名搜，拿 romaji / english / synonyms）
- 封面图托管在 `i0.hdslb.com`，**请求不能带 Referer**，否则 403
- 数据缓存在 `%APPDATA%\animelocal\`：
  - `catalog/<季度>.{html,json}`：原始页面 + 解析结果，24 小时内不重抓
  - `covers/<季度>/<id>.jpg`：封面，id = 标题的 sha1 前 12 位（稳定，换顺序也不变）
  - `aliases/<季度>.json`：AniList 查来的罗马音别名，**查到一次就一直用**，之后完全离线
  - `library.json`：「这部我本地有」的勾选记录，按季度分桶；删掉它等于清空所有标记
  - `scan.json`：上次扫描结果（扫的哪个目录、认出哪些集、哪些待确认）；删掉它等于重扫
  - `aliases.json`：手动指派时记住的文件夹名别名，下次扫到同样目录名直接认

## 资源识别怎么做的

先认作品，再抠集数：

1. **认作品**：拿文件夹名（认不出再拿文件名）跟当季番剧表比对 —— 先做规范化（全角转半角、去音标、把 `shu/syu`、`tsu/tu`、`ou/oo` 这类赫本式/训令式差异抹平），完全一致 / 一方包含另一方 / 最长公共子序列占比 ≥ 60%，分数依次下降。`≥ 0.6` 才算认出来。
2. **字幕组的罗马音也要认得**：yuc.wiki 的介绍区里有日文原名，用它去 AniList 换一组别名（罗马音、英文名、官方别名），匹配时一起比。所以 `Tensei Goblin dakedo Shitsumon Aru - 03 [1080p][CHS].mkv` 能直接落到「转生成哥布林有什么问题吗」。
3. **抠集数**：按优先级匹配 `第12话` → `S02E07` → `EP08` → 裸数字（`… - 08 …`），前面先把 `1080p / x265 / WEB-DL / [字幕组]` 这些噪音删掉，还专门把 1900~2100 的数字当年份排除。
4. **认不出的不猜**：进「待确认」，你手动指定是哪部第几集；指完会记住那个文件夹名，下次自动认。
5. 同一个文件夹名只比一次（几百个文件通常只落在几十个文件夹里），所以几千个文件也是秒级。

## 调试小工具

截图模式可以顺带验证交互，改完界面不用手动点：

```powershell
# 点前三张卡的勾选圈，然后截图
node scripts/launch.js --shot "--eval=[...document.querySelectorAll('.own-btn')].slice(0,3).forEach(b=>b.click())"

# 引号太麻烦就用文件
node scripts/launch.js --shot "--eval-file=.dev/click-owned.js"

# 直接驱动一次扫描（跳过系统选目录对话框），再截图看结果
node scripts/launch.js --shot "--eval=window.__app.scanNow('D:\\Anime')"

# 切到待确认视图
node scripts/launch.js --shot "--eval=window.__app.setFilter('pending')"
```

`window.__app` 是 `app.js` 末尾挂出来的调试入口，只在界面里存在，不影响正常使用。

## 踩过的坑

- **工程不能放在 DSH 工作区目录里**：`electron.exe` 只要位于 `...\deepseek-harness\default-workspace\` 内部，启动就 100ms 内静默退出（`crashpad_client_win.cc not connected`），跟路径长度、`node_modules`、参数都无关。搬到 `C:\Users\AsunaWhite\Projects\` 之后一切正常。
- DSH 会话注入了 `ELECTRON_RUN_AS_NODE=1`，会让 electron 跑成纯 Node（`ipcMain` 为 undefined）。启动器里必须 `delete env.ELECTRON_RUN_AS_NODE`。
- AniList 的 `Media(search:)` 搜不到时**整条请求返回 404**，一批 8 个查询会全废；必须用 `Page(perPage: 1) { media(search: …) }` 包一层，搜不到只是空数组。
- AniList 用**中文标题搜不到**，得先有日文原名（yuc.wiki 介绍区里的 `title_jp_r`）。

## 进度

- [x] 阶段 0 · 骨架：窗口 + IPC 打通
- [x] 阶段 1 · 数据源：抓取当季新番 + 封面缓存 + 卡片墙
- [x] 阶段 2 · 勾选「我有这部」+ 持久化到 library.json
- [x] 阶段 3 · 扫资源目录 + 集数识别 + 待确认 + 别名记忆
- [ ] 阶段 4 · 调用默认播放器
- [ ] 阶段 5 · 每集吐槽区
- [ ] 阶段 6 · 打包 exe
