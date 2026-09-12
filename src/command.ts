/**
 * /term command flow for dsh-open-terminal.
 *
 * Decision tree (all side effects funnel through injected seams so tests can
 * drive the exact same code path the plugin uses):
 *
 *   `~` / `~/…` prefix       → expanded to the user's home directory
 *   raw input empty          → open a terminal in the session working directory
 *   path-shaped, is a folder → open a terminal there
 *   path-shaped, is a FILE   → error (this command opens folders, not files)
 *   exact name, is a folder  → open it directly, no workspace scan
 *   exact name, is a FILE    → error (same message as above)
 *   missing path-shaped input→ fuzzy search by the last path segment
 *   anything else            → fuzzy search of the folder index
 *      0 hits                 → { kind: 'error', text: 'no match' }
 *      1 hit                  → open it directly
 *      >1 hits, dialogs ready → managed select dialog (every match; the host
 *                               panel is windowed and scrolls with ↑/↓)
 *                               → open the pick
 *      >1 hits, no dialogs    → error listing the top few candidates
 *
 * The candidate list is deliberately never trimmed to a handful: the managed
 * dialog window covers the host's own option ceiling ({@link DIALOG_MAX_OPTIONS},
 * 100 in dsh-tui 0.10.x) and the title says so whenever matches had to be
 * dropped. A broad query therefore degrades into "scroll a bit", never into
 * "the folder you meant was never offered".
 *
 * Launching is a hand-off, not a guarantee: the chain from
 * `buildTerminalChain` is walked in order, and a candidate only counts as a
 * success once it spawned AND survived the grace window without a non-zero
 * exit.
 *
 * @module dsh-open-terminal/command
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir, release as osRelease } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { rankFolders } from './fuzzy.js';
import { scanFolders, type ScanLimits, type ScannedFolder } from './scan.js';
import {
    buildTerminalChain,
    hasGraphicalSession,
    terminalHint,
    type LaunchHost,
    type SpawnSpec,
} from './terminal.js';

/** The dsh-commands result shape (structural subset — never imported). */
export interface CommandResultLike {
    readonly kind: 'success' | 'error';
    readonly text?: string;
}

/** Structural subset of `ctx.tuiDialogs` managed select requests. */
export interface TerminalDialogOptionLike {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
}

export interface TerminalDialogLike {
    select(request: {
        readonly title: string;
        readonly options: readonly TerminalDialogOptionLike[];
    }): Promise<string | undefined>;
}

/**
 * Structural subset of `@deepseek-ai/dsh-session` `SessionHeader` — the live
 * session's storage metadata. `meta` is only a construction-time input; the
 * runtime session exposes the folded result as `header`, so `session.meta` is
 * always undefined at invocation time.
 */
export interface SessionHeaderLike {
    /** Absolute working directory the session was created in, when known. */
    readonly cwd?: string;
}

/** Structural subset of `CommandInvocation`. */
export interface CommandInvocationLike {
    readonly rawInput: string;
    readonly signal: AbortSignal;
    readonly agent?: {
        readonly session?: {
            /** Live session storage metadata — the authoritative per-session cwd. */
            readonly header?: SessionHeaderLike;
            /** Legacy host alias for the same metadata (older dsh lines). */
            readonly meta?: SessionHeaderLike;
        };
    };
}

/** Everything the flow needs from the outside world. */
export interface TerminalRuntime {
    /** Session working directory (agent session cwd). */
    readonly cwd: string;
    /** Managed select dialog; missing = degrade to an error listing. */
    readonly dialogs?: TerminalDialogLike;
    /** Command cancellation signal. */
    readonly signal?: AbortSignal;
    /** Platform override for tests (defaults to process.platform). */
    readonly platform?: NodeJS.Platform;
    /** Environment for the PATH / graphical-session probes (tests inject a bare one). */
    readonly env?: NodeJS.ProcessEnv;
    /** `os.release()` override for tests (drives WSL detection). */
    readonly release?: string;
    /** Home directory for `~` expansion (tests inject a fixture). */
    readonly home?: string;
    /** Spawn seam for tests (defaults to the fire-and-forget child). */
    readonly spawn?: (spec: SpawnSpec) => Promise<boolean>;
    /** Scanner seam for tests (defaults to scanFolders). */
    readonly scan?: (root: string, limits: ScanLimits, signal?: AbortSignal) => Promise<ScannedFolder[]>;
    /** Program resolver seam (defaults to the PATH probe in `terminal.ts`). */
    readonly resolveProgram?: (name: string, host: LaunchHost) => string | null;
}

/** Effective command options (schema defaults already applied). */
export interface TerminalCommandOptions {
    /** Custom launch template; empty = the built-in per-platform chain. */
    readonly command: string;
    /** Plugin-side cap on fuzzy candidates; `0` (the default) keeps every match. */
    readonly maxCandidates: number;
    readonly includeHidden: boolean;
    readonly maxDepth: number;
    readonly maxEntries: number;
}

/**
 * How many options one managed dialog request may carry.
 *
 * Mirrors the host's own bound: `TuiDialogRuntime.select` keeps the first 100
 * options of a request and drops the rest without a word (dsh-tui 0.10.x,
 * `MAX_OPTIONS`). Keeping the request at that size means the plugin never
 * builds thousands of option objects the host would throw away, and — more
 * importantly — that the dialog title can tell the truth about what was
 * dropped. Deliberately NOT imported from the host: if a future host raises
 * its bound, this plugin simply offers fewer candidates than it could, which
 * degrades gracefully instead of touching host internals.
 */
export const DIALOG_MAX_OPTIONS = 100;

/**
 * How long a candidate gets to fail before the hand-off counts as a success.
 * A launcher that is still alive after this window has either handed the target
 * to the desktop already or is waiting on the opened terminal to exit — both
 * are "opened" from the command's point of view.
 */
export const LAUNCH_GRACE_MS = 180;

/**
 * Resolve the working directory `/term` operates on: the invoking session's
 * live cwd, read from the session header. A TUI `/workspace` switch starts a
 * NEW session whose header carries the new cwd, so this always follows the
 * current workspace. `process.cwd()` — the host process's launch directory,
 * which never changes for the life of the process — is only a last resort for
 * invocations that carry no session metadata at all.
 */
export function resolveSessionCwd(agent: CommandInvocationLike['agent']): string {
    return agent?.session?.header?.cwd ?? agent?.session?.meta?.cwd ?? process.cwd();
}

/**
 * Spawn one candidate and decide whether the hand-off worked.
 *
 * Fire-and-forget (no stdio pipes, unref'd) but not blind: a candidate that
 * cannot be spawned at all (ENOENT/EACCES) or that exits non-zero reports
 * failure so the next candidate gets its turn.
 */
export function spawnOnce(spec: SpawnSpec, graceMs: number = LAUNCH_GRACE_MS): Promise<boolean> {
    return new Promise<boolean>((resolveSpawn) => {
        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const settle = (opened: boolean): void => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimeout(timer);
            resolveSpawn(opened);
        };

        let child;
        try {
            child = spawn(spec.file, spec.args, {
                stdio: 'ignore',
                detached: spec.detached,
                windowsHide: spec.windowsHide,
                windowsVerbatimArguments: spec.windowsVerbatimArguments,
                cwd: spec.cwd,
            });
        }
        catch {
            resolveSpawn(false);
            return;
        }

        timer = setTimeout(() => settle(true), graceMs);
        // `on` (not `once`): a late error after the grace window must never
        // surface as an unhandled 'error' event.
        child.on('error', () => settle(false));
        child.once('exit', (code) => settle(code === 0));
        child.unref();
    });
}

/**
 * Expand a leading `~` (bare, `~/…` or `~\…`) to the user's home directory.
 * `~user` is deliberately left untouched: no passwd lookup, no shell parsing.
 */
export function expandTilde(value: string, home: string): string {
    if (!value.startsWith('~')) return value;
    const isBare = value.length === 1;
    const lead = isBare ? '' : value[1];
    if (!isBare && lead !== '/' && lead !== '\\') return value; // ~user — untouched
    const rest = isBare ? '' : value.slice(2);
    if (rest === '') return home;
    // `join` both normalises the separator the user typed to this platform's
    // and keeps a root home directory ("/" or "C:\") single-separated.
    return join(home, rest);
}

/** Home directory for `~` expansion, degrading to the workspace root. */
function homeDir(runtime: TerminalRuntime): string {
    if (runtime.home !== undefined && runtime.home !== '') return runtime.home;
    try {
        return homedir();
    }
    catch {
        return runtime.cwd;
    }
}

/**
 * Open a terminal in `dir`, walking the platform chain; every failure becomes an
 * error result naming what was tried.
 */
export async function launchTerminal(
    runtime: TerminalRuntime,
    dir: string,
    template = '',
): Promise<CommandResultLike> {
    // A folder that is already gone must not be reported as opened: Windows
    // Terminal would simply refuse, and a fire-and-forget shim would call that
    // a success.
    if (!existsSync(dir)) {
        return { kind: 'error', text: `目录不存在：${dir}` };
    }

    const platform = runtime.platform ?? process.platform;
    const env = runtime.env ?? process.env;
    const release = runtime.release ?? osRelease();
    if (!hasGraphicalSession(platform, env, release)) {
        return { kind: 'error', text: '当前环境没有图形会话，无法打开终端' };
    }

    const host: LaunchHost = { platform, env, release };
    const resolveSeam = runtime.resolveProgram;
    const plan = buildTerminalChain({
        dir,
        template,
        host,
        resolve: resolveSeam === undefined ? undefined : (name: string) => resolveSeam(name, host),
    });
    if (plan.error !== undefined) {
        return { kind: 'error', text: plan.error };
    }
    if (plan.specs.length === 0) {
        return { kind: 'error', text: `找不到可用的终端程序（${terminalHint(platform)}）` };
    }

    const spawnSpec = runtime.spawn ?? spawnOnce;
    const tried: string[] = [];
    for (const spec of plan.specs) {
        tried.push(spec.label);
        if (await spawnSpec(spec)) {
            return { kind: 'success', text: `已在 ${dir} 打开终端（${spec.label}）` };
        }
    }
    const attempted = [...new Set(tried)].join('、');
    return {
        kind: 'error',
        text: `无法在 ${dir} 打开终端（已尝试 ${attempted}，均失败；${terminalHint(platform)}）`,
    };
}

/** Run the full /term decision tree and settle with a command result. */
export async function runTermCommand(
    rawInput: string,
    runtime: TerminalRuntime,
    options: TerminalCommandOptions,
): Promise<CommandResultLike> {
    const trimmed = rawInput.trim();
    const query = trimmed.startsWith('~') ? expandTilde(trimmed, homeDir(runtime)) : trimmed;

    // 1) Bare /term → the session working directory.
    if (query === '') {
        return launchTerminal(runtime, runtime.cwd, options.command);
    }

    // 2) Path-shaped input: absolute, ./, ../, or containing a separator.
    //    Both separators count on every platform, so a Windows-style path typed
    //    on Linux (and vice versa) still reaches the fuzzy fallback below.
    const pathShaped = isAbsolute(query) || query.startsWith('.') || /[\\/]/u.test(query);
    if (pathShaped) {
        const target = isAbsolute(query) ? query : resolvePath(runtime.cwd, query);
        try {
            if (existsSync(target)) {
                if (statSync(target).isDirectory()) {
                    return launchTerminal(runtime, target, options.command);
                }
                return { kind: 'error', text: `${target} 是文件，不是文件夹（/term 只在文件夹打开终端）` };
            }
            // Missing path: fall through to fuzzy search (typo recovery).
        }
        catch {
            // stat race (EACCES / vanished): fall through to fuzzy search.
        }
    }

    // 3) A bare name (no separator) that exists right next to the working
    //    directory: an exact folder opens without paying for a workspace scan,
    //    and an exact file gets the honest error instead of "no folder
    //    matches". A local exact match beats a deeper fuzzy one — the user
    //    named something real.
    try {
        const direct = resolvePath(runtime.cwd, query);
        if (existsSync(direct)) {
            return statSync(direct).isDirectory()
                ? launchTerminal(runtime, direct, options.command)
                : { kind: 'error', text: `${direct} 是文件，不是文件夹（/term 只在文件夹打开终端）` };
        }
    }
    catch {
        // stat race — fall through to the fuzzy search
    }

    // 4) Fuzzy search of the folder index. For a missing path-shaped query,
    //    search by the LAST segment (what the user actually named), so
    //    "plugins/term" with a typo'd parent still finds the folder.
    const segments = query.split(/[\\/]/u).filter((segment) => segment !== '');
    const fuzzyQuery = segments.length > 0 ? segments[segments.length - 1] : query;
    const scan = runtime.scan ?? scanFolders;
    const limits: ScanLimits = {
        maxDepth: options.maxDepth,
        maxEntries: options.maxEntries,
        includeHidden: options.includeHidden,
    };
    const folders = await scan(runtime.cwd, limits, runtime.signal);
    const ranked = rankFolders(fuzzyQuery ?? '', folders, options.maxCandidates);

    if (ranked.length === 0) {
        return {
            kind: 'error',
            text: `工作区中找不到与 “${query}” 相关的文件夹（留空参数可在工作目录根打开终端）`,
        };
    }

    if (ranked.length === 1) {
        const only = ranked[0]!;
        return launchTerminal(runtime, only.absPath, options.command);
    }

    // 5) Multiple candidates: ask, open the pick, or degrade.
    const dialog = runtime.dialogs;
    if (dialog === undefined) {
        const preview = ranked
            .slice(0, 5)
            .map((folder) => folder.relPath)
            .join('；');
        const more = ranked.length > 5 ? ` 等 ${ranked.length} 项` : '';
        return {
            kind: 'error',
            text: `找到 ${ranked.length} 个匹配，但当前环境没有对话框选择，请键入更精确的路径。候选：${preview}${more}`,
        };
    }

    // Bound the request at the host's option ceiling, and SAY SO in the title
    // when matches were dropped: a silent truncation reads as "my folder is not
    // in this workspace", which is the one thing a picker must never imply.
    const shown = ranked.slice(0, DIALOG_MAX_OPTIONS);
    const dropped = ranked.length - shown.length;
    const picked = await dialog.select({
        title: dropped > 0
            ? `在哪个文件夹打开终端？（${query} · 共 ${ranked.length} 个匹配，仅显示前 ${shown.length} 个）`
            : `在哪个文件夹打开终端？（${query} · ${ranked.length} 个匹配）`,
        options: shown.map((folder) => ({
            id: folder.relPath,
            label: `📁 ${folder.basename}`,
            description: folder.relPath,
        })),
    });
    if (picked === undefined) {
        return { kind: 'success' }; // Esc / cancelled — stay quiet.
    }

    const target = resolvePath(runtime.cwd, picked);
    try {
        if (existsSync(target) && statSync(target).isDirectory()) {
            return launchTerminal(runtime, target, options.command);
        }
    }
    catch {
        // fall through to the shared error below
    }
    return { kind: 'error', text: `无法在 ${target} 打开终端（目标已失效）` };
}
