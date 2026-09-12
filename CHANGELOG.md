# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-12

### Added

- **`/term`** — open a system terminal in a workspace folder. A blank argument
  opens the session working directory, an exact neighbouring folder opens
  immediately, and anything else fuzzy-matches the workspace's folders.
- Managed-picker integration for several matches, with an unlimited candidate
  count (bounded only by the host's 100-option window, and the title states what
  was dropped).
- Ordered per-platform launcher chains: `wt.exe` → `pwsh.exe` → `powershell.exe`
  → `cmd.exe` on Windows, `open -a Terminal` on macOS, ten terminal emulators on
  Linux, plus a Windows-side Windows Terminal last resort under WSL.
- `command` configuration template with a `{dir}` placeholder for users who want
  a specific terminal (for example Windows Terminal running Git Bash).
- `maxDepth`, `maxEntries`, `maxCandidates` and `includeHidden` configuration
  keys, all defaulted.
- Bounded lifecycle log at `~/.dsh-tui/dsh-open-terminal.log`.

### Notes

- Windows candidates are resolved against `PATH` before spawning, because
  `cmd /d /s /c start "" <missing program>` still exits 0 (measured 2026-09-12).
- The program probe uses `lstatSync`, because Windows app execution aliases are
  reparse points that `existsSync` reports as missing and `statSync` cannot follow.
