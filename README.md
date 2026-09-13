# dsh-open-terminal

**English** · [中文](README.zh.md)

`/term` — open a system terminal in any folder of the workspace. A bare `/term`
opens the working-directory root; a fragment fuzzy-matches folders and asks with
the host's managed picker when several match. Built for
[dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI).

## Capabilities

- **`/term`** (no argument) → opens a system terminal **in the current session's working directory**
- **`/term docs`** → an existing folder next to the working directory opens immediately, without a workspace scan
- **`/term src/plugins`** → relative or absolute paths work, both separators accepted on every platform
- **`/term ~/projects`** → `~` / `~/…` expands to the home directory (`~user` is left alone)
- **`/term guid`** → fuzzy search of the workspace's **folders** (case-insensitive, CJK-aware, Unicode NFD/NFC normalised)
  - exactly one match → opened directly
  - several matches → the host's managed picker (TUI seam 十) lists them, **unlimited count**: the panel is windowed and scrolls with ↑/↓, Enter opens, Esc cancels
  - more matches than the host's option ceiling (100 options per request) → the first 100 are shown and the title states `共 N 个匹配，仅显示前 100 个`, never a silent truncation
  - no match → a clear error, with a reminder that a blank argument opens the working-directory root
- **`/term notes.txt`** → a clear error: it is a file, not a folder
- Opens a **new window** every time: the TUI's own terminal is never taken over

## Install

```sh
# from npm (package name: dsh-open-terminal)
dsh plugin --profile dsh-tui add dsh-open-terminal

# from a local checkout (development)
pnpm install --frozen-lockfile && pnpm build
dsh plugin --profile dsh-tui add file:<absolute path to this repository>
```

Restart the TUI afterwards (`/restart`, or reopen the window) for the command to
appear.

## Platform support

The launch is an **ordered chain**: the first candidate that spawns *and* does
not fail inside the 180 ms grace window wins; otherwise the next candidate is
tried. When the whole chain fails, the error names every program that was tried.

| Platform | Chain | Notes |
|---|---|---|
| **Windows** | `wt.exe -d <dir>` → `pwsh.exe` → `powershell.exe` → `cmd.exe` | `wt.exe` is spawned directly (a GUI launcher: it opens its own window and reports a real exit code); the console shells go through `cmd /d /s /c start "" "<exe>"`, which is what creates a **new window** — spawning them directly would attach them to the TUI's console |
| **macOS** | `open -a Terminal <dir>` | Terminal.app is always present |
| **Linux** | `gnome-terminal --working-directory=` → `konsole --workdir` → `xfce4-terminal --working-directory=` → `mate-terminal --working-directory=` → `kitty --directory` → `alacritty --working-directory` → `wezterm start --cwd` → `foot --working-directory=` → `x-terminal-emulator` → `xterm` | The last two carry no flag and receive the folder through the child's working directory |
| **WSL** | the Linux chain, then `cmd.exe /c start "" "wt.exe" -d "\\wsl$\<distro>\…"` | Works with or without WSLg |

Two Windows field findings shape the implementation (measured 2026-09-12):

1. `cmd /d /s /c start "" <missing program>` still exits **0**, so a missing
   program cannot be detected from the shim's exit code. Candidates are resolved
   against `PATH` (with `PATHEXT`) *before* anything is spawned.
2. App execution aliases (`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`, `…\pwsh.exe`)
   are `APPEXECLINK` reparse points: `fs.existsSync()` reports them as missing and
   `fs.statSync()` throws `EACCES`, while `fs.lstatSync()` succeeds. A probe built
   on `existsSync` would silently skip exactly the terminals users expect.

## Language

The command replies, error messages and the completion hint follow the host's
language. The chain is the one dsh-TUI uses:

`DSH_TUI_LANG` → the live `dsh-tui` settings namespace (where `/lang` lands) →
`~/.dsh-tui/lang.json` → the OS locale → Chinese.

- A locale that is present but unsupported (say `fr`) reads as **English**; a
  *missing* locale keeps **Chinese**, so a Chinese host that never wrote a
  preference renders exactly as before this release.
- Replies re-resolve the language on every invocation, so `/lang` takes effect
  without a restart. The registered completion hint is a snapshot from
  activation time and follows the language after a restart.
- `DSH_OPEN_TERMINAL_LANG_FILE` overrides the preference-file path (tests and
  diagnostics).

## Configuration

| Key | Default | Description |
|---|---|---|
| `command` | `''` | Launch template used **instead of** the built-in chain, with `{dir}` standing for the target folder — e.g. `wt.exe -p "Git Bash" -d {dir}` or `gnome-terminal --working-directory={dir}`. When set, the template is the whole answer: if its program cannot be resolved the command fails with a clear error rather than silently starting a different terminal |
| `maxDepth` | `6` | Maximum folder depth walked (root = 0) |
| `maxEntries` | `20000` | Maximum number of folders collected |
| `maxCandidates` | `0` | Candidates offered to the picker; `0` = unlimited (still bounded by the host's 100-option window, and the title says so) |
| `includeHidden` | `false` | Index dot-folders too |

Every key has a default, so a missing configuration degrades to the documented
behaviour. Configuration is applied through `/settings` or the profile's Cordis
configuration.

Template syntax: whitespace separates arguments, single or double quotes group
them, and `{dir}` may stand alone or be glued into a flag
(`--working-directory={dir}`). A template containing `"`, `'`, `%`, or an
unknown placeholder such as `{cwd}` is rejected with an explanation — `%` is
expanded by `cmd` even inside quotes, so it can never be passed through safely.

## Working-directory semantics

The command is anchored to the **invoking session's working directory**
(`agent.session.header.cwd`, the host-side cwd recorded in the session header),
not the host process's `cwd`. A `/workspace` switch starts a new session whose
header carries the new directory, so `/term` always follows the active
workspace. Older host lines that only expose `session.meta.cwd` are supported,
and the process launch directory is the last resort.

Relative paths in the fuzzy index use `/` on every platform, so the same index
means the same thing on Windows, macOS and Linux.

## Model experience

The command runs on the UI command plane and its result text is rendered
directly by the adapter: **no model message is produced, no tokens are billed,
and nothing enters the model's KV cache**. `command/run` / `command/done` are
recorded in the session log as log-only events.

## Known limitations

- Opening is a fire-and-forget hand-off: failures are only observed inside the
  180 ms grace window, so a launcher that dies later is not noticed, and a
  Windows app alias that exists but cannot start is reported as opened.
- Folder scanning is bounded by depth (`maxDepth`, 6 by default) and entry count
  (`maxEntries`, 20000 by default); on very large trees the scan stops at the
  cap or at the cancellation signal and the remainder is not searched.
- The managed picker's size is enforced by the **host**: `tuiDialogs.select`
  keeps the first 100 options of a request and silently drops the rest (dsh-tui
  0.10.x). This plugin aligns to that ceiling and states the drop in the title,
  but **more than 100 candidates cannot be displayed** on that host; a truly
  unlimited picker would need a `tuiScenes`-drawn selector.
- Windows Terminal decides between a new window and a new tab according to its
  own `windowingBehavior` setting; this plugin passes `-d <folder>` only and does
  not force either. When `wt.exe` is unusable but present, the chain cannot tell
  and reports the hand-off as successful.
- Symlinked folders are indexed but never descended into (cycle and escape
  protection).
- `~` expansion covers `~`, `~/…` and `~\…` only; `~user` is not resolved.
- No graphical session = clear refusal: Linux needs `DISPLAY` or
  `WAYLAND_DISPLAY` (WSL counts as reachable through the Windows side).
- Two diagnostic log lines are the only files this plugin writes
  (`~/.dsh-tui/dsh-open-terminal.log`); it never writes into the workspace and
  never appends session events.

## Publishing

- **Repository**: <https://github.com/VviLliAm-qwq/dsh-open-terminal> (public)
- **Versioning**: semantic versioning; releases are driven by `v*` tags
  (`.github/workflows/release.yml` verifies that the tag matches
  `package.json`, then runs build/test/manifest/pack checks,
  `npm publish --provenance`, and creates a GitHub Release)
- **Prerequisite**: a Trusted Publisher configured for this package on npm
  (GitHub Actions · this repository · `release.yml`) — publishing uses OIDC, so
  no token is stored in the repository
- **Ecosystem listing**: this README carries the
  [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) link required by
  <https://dshtui.com/plugins/>

## Development and verification

```sh
pnpm install
pnpm build              # tsc -> lib/
pnpm test               # vitest (platform branches are exercised through injected platform/env/path probes)
pnpm validate:manifest  # dsh-plugin.json admission-shape check
pnpm pack:verify        # published-artifact layout check
pnpm prepublishOnly     # all four, in order
```

The entry module (`src/index.ts` → `lib/index.js`) deliberately re-exports
exactly `{ Config, apply, name }`; `test/entry.test.ts` pins that shape, because
a richer module namespace makes the dsh-TUI seams refuse the plugin's
registrations without any visible error.

Integration check on a real host composition:

```sh
node tools/probe-plugin.mjs plugins/dsh-open-terminal   # exit code 0 = registrations accepted
```

## License

[MIT](LICENSE)
