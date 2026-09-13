# dsh-open-terminal

**中文** · [English](README.md)

`/term` —— 在工作区的任意文件夹里打开系统终端。不带参数时打开工作目录根；带参数时对文件夹做模糊搜索，多个匹配交给宿主的托管选择框。为
[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 打造。

## 能力

- **`/term`**（无参数）→ 在**当前会话工作目录**打开系统终端
- **`/term docs`** → 工作目录旁已存在的同名文件夹直接打开，无需扫描工作区
- **`/term src/plugins`** → 相对路径与绝对路径均可，两个平台的路径分隔符都接受
- **`/term ~/projects`** → `~` / `~/…` 展开为主目录（`~user` 不展开）
- **`/term guid`** → 对工作区的**文件夹**做模糊搜索（大小写不敏感、支持中文，Unicode NFD/NFC 归一化）
  - 唯一命中 → 直接打开
  - 多个命中 → 宿主托管选择框（TUI 接缝十），**匹配数不限**：弹窗按终端高度开窗，↑/↓ 滚动，Enter 打开，Esc 取消
  - 命中超过宿主单次请求上限（100 项）→ 只显示前 100 项，标题写明 `共 N 个匹配，仅显示前 100 个`，绝不静默截断
  - 零命中 → 明确报错，并提示留空参数可打开工作目录根
- **`/term notes.txt`** → 明确报错：这是文件，不是文件夹
- 每次都开**新窗口**，绝不接管 TUI 自己的终端

## 安装

```sh
# 从 npm 安装（包名：dsh-open-terminal）
dsh plugin --profile dsh-tui add dsh-open-terminal

# 本地仓库安装（开发）
pnpm install --frozen-lockfile && pnpm build
dsh plugin --profile dsh-tui add file:<本仓库绝对路径>
```

安装后需在 TUI 内 `/restart`（或重开窗口）生效。

## 平台支持

打开动作按**有序候选链**执行：第一个能启动且未在 180 ms 宽限窗口内快速失败的候选胜出，否则自动回退下一个；整链失败时，报错会列出所有尝试过的程序。

| 平台 | 候选链 | 说明 |
|---|---|---|
| **Windows** | `wt.exe -d <目录>` → `pwsh.exe` → `powershell.exe` → `cmd.exe` | `wt.exe` 直接 spawn（GUI 启动器：自己开窗、退出码可信）；三个控制台 shell 经 `cmd /d /s /c start "" "<exe>"` 启动，**这样才会开新窗口** —— 直接 spawn 会把它们挂到 TUI 的控制台上 |
| **macOS** | `open -a Terminal <目录>` | Terminal.app 一定存在 |
| **Linux** | `gnome-terminal --working-directory=` → `konsole --workdir` → `xfce4-terminal --working-directory=` → `mate-terminal --working-directory=` → `kitty --directory` → `alacritty --working-directory` → `wezterm start --cwd` → `foot --working-directory=` → `x-terminal-emulator` → `xterm` | 最后两个不带参数，通过子进程工作目录落地 |
| **WSL** | 先走 Linux 链，再兜底 `cmd.exe /c start "" "wt.exe" -d "\\wsl$\<发行版>\…"` | 有无 WSLg 均可用 |

两条 Windows 实测结论（2026-09-12）决定了实现方式：

1. `cmd /d /s /c start "" <不存在的程序>` **退出码仍是 0**，所以「程序缺失」无法从 shim 的退出码发现；候选程序一律先按 `PATH`（含 `PATHEXT`）解析，再启动。
2. 应用执行别名（`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`、`…\pwsh.exe`）是 `APPEXECLINK` 重解析点：`fs.existsSync()` 判定为不存在，`fs.statSync()` 抛 `EACCES`，只有 `fs.lstatSync()` 成功。基于 `existsSync` 的探测会静默漏掉用户最想要的那个终端。

## 语言 / Language

命令回执、错误提示与补全提示都跟随宿主语言，解析链与 dsh-TUI 一致：

`DSH_TUI_LANG` → 运行中的 `dsh-tui` 设置命名空间（`/lang` 的落点）→
`~/.dsh-tui/lang.json` → 系统 locale → 中文。

- 语言**存在但不支持**（如 `fr`）时回落英文；**完全没有信息**时沿用中文，保证中文宿主的行为与加入双语之前完全一致。
- 回执在每次调用时重新解析语言，`/lang` 切换**无需重启**；命令补全里的提示是注册时的快照，重启后跟随新语言。
- `DSH_OPEN_TERMINAL_LANG_FILE` 可覆盖偏好文件路径（测试与诊断用）。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `command` | `''` | 用自定义启动模板**取代**内置链，`{dir}` 代表目标文件夹，例如 `wt.exe -p "Git Bash" -d {dir}` 或 `gnome-terminal --working-directory={dir}`。设置后模板即最终答案：程序解析不到就明确报错，绝不静默换成别的终端 |
| `maxDepth` | `6` | 目录扫描深度上限（根 = 0） |
| `maxEntries` | `20000` | 索引文件夹数量上限 |
| `maxCandidates` | `0` | 交给选择框的候选数；`0` = 不限（仍受宿主 100 项窗口约束，且标题会写明） |
| `includeHidden` | `false` | 是否索引点开头的隐藏文件夹 |

所有键都有默认值，缺省即按上表行为降级。配置经 `/settings` 或 profile 的 Cordis 配置覆盖。

模板语法：空白分隔参数，单/双引号可包裹含空格的参数，`{dir}` 可独立成项也可拼进参数（`--working-directory={dir}`）。含 `"`、`'`、`%` 或未知占位符（如 `{cwd}`）的模板会被拒绝并说明原因 —— `%` 即使在引号内也会被 `cmd` 展开，无法安全透传。

## 工作目录语义

命令以**接收会话的工作目录**（`agent.session.header.cwd`，DSH 会话头记录的 host-side cwd）为基准，而非宿主进程的 `cwd`。TUI 里 `/workspace` 切换会新建会话，新会话头即新目录，所以 `/term` 始终跟手；只暴露 `session.meta.cwd` 的旧版宿主同样支持，进程启动目录是最后兜底。

模糊索引的相对路径统一以 `/` 分隔，因此同一份索引在三个平台语义一致。

## Model Experience

命令在 UI 命令平面执行，结果文本由适配器直接渲染：**不产生模型消息、不计入模型 token、不进入模型 KV 缓存**。`command/run` / `command/done` 仅以 log-only 事件记录到会话日志。

## Known Limitations

- 打开是 fire-and-forget 交接：只在 180 ms 宽限窗口内观测失败，之后才崩溃的启动器不会被察觉；Windows 上「别名存在但实际起不来」会被上报为已打开。
- 模糊索引受深度（`maxDepth`，默认 6 层）与条目数（`maxEntries`，默认 20000）上限约束；超大目录树上扫描在取消信号或上限处截止，超出的部分不被检索。
- 托管选择框的条数由**宿主**兜底：dsh-tui 0.10.x 的 `tuiDialogs.select` 只保留请求里的前 100 个选项（超出静默丢弃，插件拿不到该常量）。本插件主动对齐 100 并写明丢弃数量，但**超过 100 条的候选在当前宿主上无法展示**；需要真·不限量得改走 `tuiScenes` 自绘选择器。
- Windows Terminal 按自身的 `windowingBehavior` 设置决定开新窗口还是新标签页；本插件只传 `-d <目录>`，不强制二者之一。
- 指向目录的符号链接会被索引为候选，但**不会被递归遍历**（防环、防越出工作区）。
- `~` 展开仅支持 `~` / `~/…` / `~\…`，不解析 `~user`。
- 无图形会话时明确拒绝：Linux 需 `DISPLAY` 或 `WAYLAND_DISPLAY`；WSL 视为可经 Windows 侧打开。
- 除自身日志 `~/.dsh-tui/dsh-open-terminal.log` 外，本插件不写任何文件、不向工作区落盘、不追加 session 事件。

## 发布

- **仓库**：<https://github.com/VviLliAm-qwq/dsh-open-terminal>（公开）
- **版本**：语义化版本；发布由 `v*` tag 驱动（`.github/workflows/release.yml` 校验 tag 与 `package.json` 一致 → build/test/manifest/pack 校验 → `npm publish --provenance` → 创建 GitHub Release）
- **前置**：npm 包已配置 Trusted Publisher（GitHub Actions · 本仓库 · `release.yml`）——发布走 OIDC，无需在仓库里存放任何令牌
- **生态收录**：本 README 顶部带有 <https://dshtui.com/plugins/> 要求的 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 链接

## 开发与验证

```sh
pnpm install
pnpm build              # tsc -> lib/
pnpm test               # vitest（平台分支通过注入 platform/env/PATH 探测实现跨平台覆盖）
pnpm validate:manifest  # dsh-plugin.json 准入形状检查
pnpm pack:verify        # 发布包布局检查
pnpm prepublishOnly     # 四合一
```

入口模块（`src/index.ts` → `lib/index.js`）刻意只再导出 `{ Config, apply, name }`；`test/entry.test.ts` 锁死该形状 —— 导出更多符号会让 dsh-TUI 的接缝静默拒绝整个插件的注册。

真实组合下的集成探测：

```sh
node tools/probe-plugin.mjs plugins/dsh-open-terminal   # 退出码 0 = 注册被宿主接受
```

## License

[MIT](LICENSE)
