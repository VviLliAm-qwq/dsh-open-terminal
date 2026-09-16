# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.2.1] - 2026-09-13

### Changed

- Documentation only, no code change: a CI badge under the title, and the publishing section records that the release workflow publishes through npm trusted publishing (OIDC) with no stored token.

## [Unreleased]

## [0.2.2] - 2026-09-16

### Added

- **`kgx` (GNOME Console) joins the Linux chain**, right after `gnome-terminal`, so Fedora and other GNOME 42+ desktops stop reporting `noTerminalFound`. Its `--working-directory=` option is verified against the upstream `GOptionEntry` and the Ubuntu manpage. `tilix` and `terminator` are appended at the end of the explicit-working-directory group (before `x-terminal-emulator`) so no existing entry changes its relative order; both verified against their manpages.

### Fixed

- **A folder whose name contains `%` no longer reaches the `cmd` command line.** The `%` check ran on the template *before* `{dir}` was substituted, so a directory named `50%off` still landed in `cmd /c start`, where `%` is expanded or truncated even inside quotes. The final `[programPath, ...argv]` is now re-checked after substitution (only when the platform really goes through `cmd`), and a hit reports a clear error naming the directory. The WSL `cmd.exe` fallback candidate is dropped in that case while the Linux chain above it still opens the folder. An apostrophe (`Bob's stuff`) is deliberately *not* rejected: it is a valid Windows directory name and is meaningless to `cmd`.

### Documentation

- The READMEs no longer describe quotes in a launch template as "rejected": quotes are grouping characters, and the branch that refuses them only fires when a *different* quote is nested inside a quoted group.
- The development/verification section is marked as checkout-only. The published package ships `lib/`, the manifest, the patch and the docs — not `src/`, `test/`, `scripts/` or the workspace `tools/`, so `node tools/probe-plugin.mjs` cannot be run from an npm install.
- Both READMEs record that the graphical-session check is a no-op on Windows: a headless Windows host fails at the spawn / grace-window stage instead of reporting "no graphical session".
- `package.json` gains the discovery `keywords` (including `dsh-plugin`).

## [0.2.0] - 2026-09-13

### Added

- **Bilingual output.** Every string the command renders — replies, errors, the
  candidate list, the picker's title and the three platform launcher hints — now
  follows the host's language, resolved through the same chain dsh-TUI uses:
  `DSH_TUI_LANG` → the live `dsh-tui` settings namespace → `~/.dsh-tui/lang.json`
  → the OS locale → Chinese. A locale that is present but unsupported reads as
  English; a *missing* locale keeps Chinese, so a Chinese host that never wrote a
  preference renders exactly as before.
- The command definition carries a `descriptions { zh, en }` map for the host to
  localize, and the input hint is rendered in the resolved language.
- `src/i18n.ts` exports the resolution chain (`resolveLang`, `normalizeLang`,
  `langFilePath`) and the dictionary (`t`, `STRING_KEYS`); both READMEs gained a
  **Language** section.
- Tests for the dictionaries and the resolution chain: key parity between the two
  languages, precedence (env → host setting → file → locale), unsupported-locale
  behaviour, unknown keys and placeholder substitution.

### Changed

- The language is re-resolved on every invocation, so a `/lang` switch reaches
  the next reply without a restart.
- `terminalHint(platform, lang?)` takes an optional language; existing callers
  keep working through the default.

### Notes

- Modules under `lib/` are `tsc` build output: change `src/` and rebuild.

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
