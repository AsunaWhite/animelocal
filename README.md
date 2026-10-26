# 本季番剧库 · AnimeLocal

管理本地动画视频的 Windows 桌面应用。自动拉取当季新番清单，识别你硬盘上的资源属于哪一部第几集，一键用默认播放器打开，每集还能记吐槽。

## 跑起来

```powershell
npm install      # 第一次才需要
npm start        # 启动
npm run dev      # 启动 + 自动开 DevTools
npm run shot     # 截图到 .dev/shot.png（验证界面用，截完自动退出）
npm test         # 离线跑解析测试（对 fixture 对答案，不联网）
node scripts/test-catalog.js --live   # 联网抓当季，验证缓存
```

> Electron 的 stdout/stderr 一旦接进 PowerShell 管道就会崩（`crashpad not connected`），所以 `scripts/launch.js` 把子进程输出重定向到 `.dev/electron.log`，退出时再把日志尾巴打印出来。

## 目录结构

```
src/
  main/main.js        主进程：开窗口、IPC
  main/catalog.js     抓 yuc.wiki + 解析 + 封面缓存（纯 Node，可单独测试）
  preload/preload.js  桥：只把白名单能力暴露给界面
  renderer/           界面：HTML + CSS + 原生 JS，没有框架、没有打包
    index.html
    style.css
    app.js
scripts/
  launch.js           启动器：清掉 ELECTRON_RUN_AS_NODE、重定向日志
  test-catalog.js     解析测试
test/fixtures/        202610 季度页快照 + 旧 Python 版的解析结果（对答案基准）
```

**为什么分三层**：主进程有系统权限（能删你的文件），界面层跑的是网页代码。中间隔一道 preload 白名单，界面就只能做你允许它做的事。这是 Electron 的基本安全模型。

## 数据来源

- 动画清单 + 封面：<https://yuc.wiki/>（季度号形如 `202610`，1/4/7/10 月）
- 封面图托管在 `i0.hdslb.com`，**请求不能带 Referer**，否则 403
- 数据缓存在 `%APPDATA%\animelocal\`：
  - `catalog/<季度>.{html,json}`：原始页面 + 解析结果，24 小时内不重抓
  - `covers/<季度>/<id>.jpg`：封面，id = 标题的 sha1 前 12 位（稳定，换顺序也不变）

## 踩过的坑

- **工程不能放在 DSH 工作区目录里**：`electron.exe` 只要位于 `...\deepseek-harness\default-workspace\` 内部，启动就 100ms 内静默退出（`crashpad_client_win.cc not connected`），跟路径长度、`node_modules`、参数都无关。搬到 `C:\Users\AsunaWhite\Projects\` 之后一切正常。
- DSH 会话注入了 `ELECTRON_RUN_AS_NODE=1`，会让 electron 跑成纯 Node（`ipcMain` 为 undefined）。启动器里必须 `delete env.ELECTRON_RUN_AS_NODE`。

## 进度

- [x] 阶段 0 · 骨架：窗口 + IPC 打通
- [x] 阶段 1 · 数据源：抓取当季新番 + 封面缓存 + 卡片墙
- [ ] 阶段 2 · 勾选「我有这部」+ 持久化
- [ ] 阶段 3 · 扫资源目录 + 集数识别 + 待确认
- [ ] 阶段 4 · 调用默认播放器
- [ ] 阶段 5 · 每集吐槽区
- [ ] 阶段 6 · 打包 exe
