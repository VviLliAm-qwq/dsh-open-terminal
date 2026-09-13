/**
 * Platform terminal-launch specs for dsh-open-terminal.
 *
 * Pure functions only: they assemble an ORDERED list of spawn descriptors and
 * the caller owns the actual `child_process.spawn`. Keeping the assembly pure
 * means every platform branch is unit-testable on any host, and the ordered
 * list is what makes the command survive machines that ship only some of the
 * plausible terminals: the caller walks the list and falls through whenever a
 * candidate cannot be spawned or fails fast.
 *
 * Channels per platform:
 *  - win32   `wt.exe -d <dir>` (spawned directly — a GUI launcher, so it opens
 *            its own window and reports a truthful exit code) → `pwsh.exe` →
 *            `powershell.exe` → `cmd.exe`. The three console shells go through
 *            `cmd /d /s /c start "" "<exe>"` instead of being spawned directly:
 *            a console program spawned from the TUI's own console inherits that
 *            console and would take over the TUI's terminal rather than open a
 *            window.
 *  - darwin  `open -a Terminal <dir>`.
 *  - linux   a preference-ordered chain of emulators that accept an explicit
 *            working directory (gnome-terminal, konsole, xfce4-terminal,
 *            mate-terminal, kitty, alacritty, wezterm, foot) and finally the
 *            generic `x-terminal-emulator` / `xterm`, which get the directory
 *            through the child's `cwd`.
 *  - WSL     the Linux chain first (WSLg), then a Windows-side
 *            `cmd.exe /c start "" "wt.exe" -d "\\wsl$\<distro>\…"` last resort.
 *
 * Field findings (measured on Windows 11, 2026-09-12) that shape this file:
 *  1. `cmd /d /s /c start "" <missing program>` still exits 0, so a missing
 *     program cannot be detected from the shim's exit code. Candidates are
 *     therefore pre-resolved against PATH before any spawn is attempted.
 *  2. App execution aliases (`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`,
 *     `…\pwsh.exe`) are APPEXECLINK reparse points: `existsSync()` reports
 *     FALSE and `statSync()` throws EACCES, while `lstatSync()` succeeds. A
 *     probe built on `existsSync` would silently skip exactly the terminals
 *     users expect, which is why {@link executableProbe} uses `lstatSync`.
 *  3. `%` must never reach a `cmd` command line (it expands `%VAR%`), and the
 *     shim cannot carry quotes safely — {@link parseLaunchTemplate} rejects
 *     both in user configuration instead of escaping them.
 *
 * @module dsh-open-terminal/terminal
 */
import { accessSync, constants, lstatSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { resolveLang, t, type Lang } from './i18n.js';

/** A spawn descriptor compatible with `child_process.spawn` options. */
export interface SpawnSpec {
    readonly file: string;
    readonly args: string[];
    /** Working directory handed to the child (also how shells inherit the folder). */
    readonly cwd?: string;
    readonly windowsHide: boolean;
    readonly detached: boolean;
    readonly windowsVerbatimArguments: boolean;
}

/** A spawn descriptor plus the human-facing program name of its candidate. */
export interface TerminalSpawnSpec extends SpawnSpec {
    readonly label: string;
}

/** Everything platform resolution needs to know about the host. */
export interface LaunchHost {
    /** Target platform (defaults to the real one at the call sites). */
    readonly platform: NodeJS.Platform;
    /** Environment, for PATH/PATHEXT/ComSpec and DISPLAY / WSL detection. */
    readonly env: NodeJS.ProcessEnv;
    /** `os.release()` — the WSL kernel marker ("…-microsoft-standard-WSL2"). */
    readonly release: string;
}

/** The host we are actually running on. */
export function currentHost(platform: NodeJS.Platform = process.platform): LaunchHost {
    return { platform, env: process.env, release: osRelease() };
}

/**
 * Is this Linux actually a WSL distribution? Best effort and pure: the env
 * markers are set by WSL itself, and the kernel release string carries
 * "microsoft" on both WSL1 and WSL2.
 */
export function detectWsl(
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    release = '',
): boolean {
    if (platform !== 'linux') return false;
    if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) return true;
    return /microsoft/iu.test(release);
}

/**
 * Is this environment able to reach a graphical session at all?
 *
 * Windows and macOS always can (the terminal is part of the session); a WSL
 * distro can through the Windows side; a plain Linux box needs a display
 * server. `env`/`release` are injectable so the answer is testable on any host
 * instead of depending on the machine that happens to run the suite.
 */
export function hasGraphicalSession(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    release: string = osRelease(),
): boolean {
    if (platform === 'win32') return true;
    if (platform === 'darwin') return true;
    if (detectWsl(platform, env, release)) return true;
    return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** Human-facing hint appended when no candidate could be started. */
export function terminalHint(platform: NodeJS.Platform, lang: Lang = resolveLang()): string {
    if (platform === 'win32') {
        return t(lang, 'hintWindows');
    }
    if (platform === 'darwin') return t(lang, 'hintMac');
    return t(lang, 'hintLinux');
}

// ---------------------------------------------------------------------------
// Configuration template
// ---------------------------------------------------------------------------

/** The only placeholder a `command` template may carry. */
export const DIR_PLACEHOLDER = '{dir}';

/**
 * Characters that must never reach a `cmd` command line built by this plugin.
 * `%` is expanded by cmd even inside quotes; a quote would break the fixed
 * `start "" <exe> <args>` shape. Both are rejected in configuration rather
 * than half-escaped.
 */
const FORBIDDEN_TEMPLATE_CHARS: readonly string[] = ['"', "'", '%', '\n', '\r', '\0'];

/** Result of parsing a `command` template: tokens, or why it was rejected. */
export interface TemplateParseResult {
    readonly tokens: string[];
    readonly error?: string;
}

/**
 * Split a `command` template into argv tokens.
 *
 * Whitespace separates tokens; single and double quotes group them (the quotes
 * themselves are not part of the token, so `-p "Git Bash"` yields `-p` and
 * `Git Bash`). `{dir}` may stand alone or be glued to other characters
 * (`--working-directory={dir}`). Unknown placeholders and the characters listed
 * in {@link FORBIDDEN_TEMPLATE_CHARS} are rejected with a clear error.
 */
export function parseLaunchTemplate(template: string): TemplateParseResult {
    const tokens: string[] = [];
    let current = '';
    let started = false;
    let quote: string | null = null;

    for (const char of template) {
        if (quote !== null) {
            if (char === quote) {
                quote = null;
                continue;
            }
            current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            started = true;
            continue;
        }
        if (/\s/u.test(char)) {
            if (started) tokens.push(current);
            current = '';
            started = false;
            continue;
        }
        current += char;
        started = true;
    }

    if (quote !== null) {
        return { tokens: [], error: `终端命令模板的引号未闭合：${template}` };
    }
    if (started) tokens.push(current);
    if (tokens.length === 0) {
        return { tokens: [], error: '终端命令模板为空' };
    }

    for (const token of tokens) {
        for (const bad of FORBIDDEN_TEMPLATE_CHARS) {
            if (token.includes(bad)) {
                return {
                    tokens: [],
                    error: `终端命令模板不允许包含 ${JSON.stringify(bad)} 字符（cmd 会展开或截断）：${token}`,
                };
            }
        }
        for (const placeholder of token.match(/\{[^}]*\}/gu) ?? []) {
            if (placeholder !== DIR_PLACEHOLDER) {
                return { tokens: [], error: `未知占位符 ${placeholder}（只支持 ${DIR_PLACEHOLDER}）` };
            }
        }
    }

    return { tokens };
}

/** Replace `{dir}` in every token that carries it (standalone or inline). */
export function substituteTemplateTokens(tokens: readonly string[], dir: string): string[] {
    return tokens.map((token) => (token.includes(DIR_PLACEHOLDER) ? token.split(DIR_PLACEHOLDER).join(dir) : token));
}

/** Does this token list place the directory itself on the command line? */
export function carriesDirPlaceholder(tokens: readonly string[]): boolean {
    return tokens.some((token) => token.includes(DIR_PLACEHOLDER));
}

// ---------------------------------------------------------------------------
// Program resolution (PATH lookup)
// ---------------------------------------------------------------------------

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** PATHEXT entries, falling back to the Windows default when unset/empty. */
export function pathExtensions(pathext: string | undefined): string[] {
    const raw = pathext === undefined || pathext === '' ? DEFAULT_PATHEXT : pathext;
    return raw.split(';').map((ext) => ext.trim()).filter((ext) => ext !== '');
}

/**
 * Build the "can this path be started?" predicate for a platform.
 *
 * Windows: `lstatSync` only — app execution aliases are reparse points that
 * `statSync` cannot follow (EACCES) and `existsSync` reports as missing, so
 * following the link is exactly what breaks the probe.
 * POSIX: a non-directory that carries the executable bit; symlinked launchers
 * (`x-terminal-emulator` is an alternatives symlink) must keep working.
 */
export function executableProbe(platform: NodeJS.Platform): (path: string) => boolean {
    if (platform === 'win32') {
        return (path: string): boolean => {
            try {
                return !lstatSync(path).isDirectory();
            }
            catch {
                return false;
            }
        };
    }
    return (path: string): boolean => {
        try {
            if (lstatSync(path).isDirectory()) return false;
            accessSync(path, constants.X_OK);
            return true;
        }
        catch {
            return false;
        }
    };
}

/** Options for {@link resolveProgram}. */
export interface ProgramProbeOptions {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    /** Injected for tests; defaults to {@link executableProbe} for the platform. */
    readonly isExecutable?: (path: string) => boolean;
}

/** Strip the quotes Windows PATH entries are occasionally wrapped in. */
function stripQuotes(value: string): string {
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
    return value;
}

/**
 * Resolve a bare program name (or a path-containing name) to an absolute path,
 * the way a shell would: PATH order, PATH-extended on Windows. Returns null when
 * nothing spawnable is found — that is what lets the caller skip a candidate
 * instead of discovering a missing program through an unreliable exit code.
 *
 * Joining is done by hand (not `path.join`) so the platform argument, not the
 * host machine, decides the separator: the Linux and Windows branches must both
 * be exercisable from any CI runner.
 */
export function resolveProgram(name: string, options: ProgramProbeOptions): string | null {
    const trimmed = name.trim();
    if (trimmed === '') return null;
    const isExecutable = options.isExecutable ?? executableProbe(options.platform);
    const windows = options.platform === 'win32';
    const separator = windows ? '\\' : '/';

    if (/[\\/]/u.test(trimmed)) {
        return isExecutable(trimmed) ? trimmed : null;
    }

    const pathValue = options.env.PATH ?? options.env.Path ?? '';
    if (pathValue === '') return null;
    const suffixes = windows ? ['', ...pathExtensions(options.env.PATHEXT)] : [''];

    for (const rawEntry of pathValue.split(windows ? ';' : ':')) {
        const dir = stripQuotes(rawEntry.trim());
        if (dir === '') continue;
        for (const suffix of suffixes) {
            const base = dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + separator;
            const candidate = base + trimmed + suffix;
            if (isExecutable(candidate)) return candidate;
        }
    }
    return null;
}

// ---------------------------------------------------------------------------
// Candidate chains
// ---------------------------------------------------------------------------

/** How a candidate starts: directly, or through the Windows new-window shim. */
type Kickoff = 'direct' | 'shim';

/** One entry of a platform chain. */
interface TerminalCandidate {
    readonly program: string;
    readonly argv: (dir: string) => string[];
    readonly kickoff: Kickoff;
}

/**
 * Windows chain. `wt.exe` is a GUI launcher: spawned directly it opens its own
 * window and reports a real exit code. The console shells must be started
 * through the shim or they would attach to the TUI's console.
 */
const WINDOWS_CANDIDATES: readonly TerminalCandidate[] = [
    { program: 'wt.exe', argv: (dir) => ['-d', dir], kickoff: 'direct' },
    { program: 'pwsh.exe', argv: () => [], kickoff: 'shim' },
    { program: 'powershell.exe', argv: () => [], kickoff: 'shim' },
    { program: 'cmd.exe', argv: () => [], kickoff: 'shim' },
];

/** macOS chain: Terminal.app takes the folder as its argument. */
const DARWIN_CANDIDATES: readonly TerminalCandidate[] = [
    { program: 'open', argv: (dir) => ['-a', 'Terminal', dir], kickoff: 'direct' },
];

/**
 * Linux chain, most specific working-directory flag first. The last two carry
 * no flag and rely on the child's `cwd`, which is the only thing the generic
 * `x-terminal-emulator` and `xterm` understand.
 */
const LINUX_CANDIDATES: readonly TerminalCandidate[] = [
    { program: 'gnome-terminal', argv: (dir) => [`--working-directory=${dir}`], kickoff: 'direct' },
    { program: 'konsole', argv: (dir) => ['--workdir', dir], kickoff: 'direct' },
    { program: 'xfce4-terminal', argv: (dir) => [`--working-directory=${dir}`], kickoff: 'direct' },
    { program: 'mate-terminal', argv: (dir) => [`--working-directory=${dir}`], kickoff: 'direct' },
    { program: 'kitty', argv: (dir) => ['--directory', dir], kickoff: 'direct' },
    { program: 'alacritty', argv: (dir) => ['--working-directory', dir], kickoff: 'direct' },
    { program: 'wezterm', argv: (dir) => ['start', '--cwd', dir], kickoff: 'direct' },
    { program: 'foot', argv: (dir) => [`--working-directory=${dir}`], kickoff: 'direct' },
    { program: 'x-terminal-emulator', argv: () => [], kickoff: 'direct' },
    { program: 'xterm', argv: () => [], kickoff: 'direct' },
];

function platformCandidates(host: LaunchHost): readonly TerminalCandidate[] {
    if (host.platform === 'win32') return WINDOWS_CANDIDATES;
    if (host.platform === 'darwin') return DARWIN_CANDIDATES;
    return LINUX_CANDIDATES;
}

/** Always double-quote one token for the `cmd /c start` command line. */
export function quoteForCmd(token: string): string {
    return `"${token}"`;
}

function directSpec(label: string, file: string, args: string[], dir: string): TerminalSpawnSpec {
    return {
        file,
        args,
        cwd: dir,
        windowsHide: false,
        detached: true,
        windowsVerbatimArguments: false,
        label,
    };
}

/**
 * The Windows new-window shim: `cmd /d /s /c start "" "<exe>" <args…>`.
 *
 * The empty quoted title is mandatory (otherwise `start` treats a quoted target
 * as the window title), and every token is quoted so a folder with spaces stays
 * one argument. `cwd` is set as well, so a shell started without an explicit
 * directory still lands in the requested folder.
 */
function consoleShimSpec(
    host: LaunchHost,
    label: string,
    programPath: string,
    argv: readonly string[],
    dir: string,
): TerminalSpawnSpec {
    const comspec = host.env.ComSpec !== undefined && host.env.ComSpec !== '' ? host.env.ComSpec : 'cmd.exe';
    const quoted = [programPath, ...argv].map(quoteForCmd).join(' ');
    return {
        file: comspec,
        args: ['/d', '/s', '/c', `start "" ${quoted}`],
        cwd: dir,
        windowsHide: false,
        detached: true,
        windowsVerbatimArguments: true,
        label,
    };
}

/** Translate a WSL path into the `\\wsl$\<distro>\…` form Windows tools accept. */
export function wslUncPath(dir: string, distro: string): string {
    const parts = dir.split('/').filter((part) => part !== '');
    return `\\\\wsl$\\${distro}\\${parts.join('\\')}`;
}

/** Last-resort WSL channel: hand the folder to a Windows-side Windows Terminal. */
function wslFallbackSpec(cmdPath: string, dir: string, distro: string): TerminalSpawnSpec {
    const unc = wslUncPath(dir, distro);
    return {
        file: cmdPath,
        args: ['/d', '/s', '/c', `start "" "wt.exe" "-d" ${quoteForCmd(unc)}`],
        cwd: dir,
        windowsHide: false,
        detached: true,
        windowsVerbatimArguments: true,
        label: 'wt.exe (Windows side)',
    };
}

/** Everything {@link buildTerminalChain} needs. */
export interface TerminalLaunchRequest {
    /** Absolute target folder; also the shell's working directory. */
    readonly dir: string;
    /** Configured `command` template; empty = the built-in chain. */
    readonly template?: string;
    readonly host: LaunchHost;
    /** Resolver seam (defaults to {@link resolveProgram} against `host.env`). */
    readonly resolve?: (name: string) => string | null;
}

/** The ordered candidates for one request, or why none could be built. */
export interface TerminalLaunchPlan {
    readonly specs: TerminalSpawnSpec[];
    /** A configuration problem (bad template / missing program) — not "not installed". */
    readonly error?: string;
}

/**
 * Assemble the ordered spawn chain for `dir`.
 *
 * With a `command` template the template IS the answer: its program must
 * resolve, and no built-in candidate is appended (silently substituting a
 * different terminal for the one the user configured would be worse than
 * failing). Without one, every built-in candidate that exists on this machine
 * is offered in preference order.
 */
export function buildTerminalChain(request: TerminalLaunchRequest): TerminalLaunchPlan {
    const { host, dir } = request;
    const resolve = request.resolve
        ?? ((name: string): string | null => resolveProgram(name, { platform: host.platform, env: host.env }));

    const template = (request.template ?? '').trim();
    if (template !== '') {
        const parsed = parseLaunchTemplate(template);
        if (parsed.error !== undefined) return { specs: [], error: parsed.error };
        const [program, ...rest] = parsed.tokens;
        if (program === undefined) return { specs: [], error: '终端命令模板为空' };
        const programPath = resolve(program);
        if (programPath === null) {
            return { specs: [], error: `配置的终端程序不可用：${program}（已按 PATH 查找）` };
        }
        const argv = substituteTemplateTokens(rest, dir);
        const spec = host.platform === 'win32'
            ? consoleShimSpec(host, program, programPath, argv, dir)
            : directSpec(program, programPath, argv, dir);
        return { specs: [spec] };
    }

    const specs: TerminalSpawnSpec[] = [];
    for (const candidate of platformCandidates(host)) {
        const programPath = resolve(candidate.program);
        if (programPath === null) continue;
        specs.push(candidate.kickoff === 'shim'
            ? consoleShimSpec(host, candidate.program, programPath, candidate.argv(dir), dir)
            : directSpec(candidate.program, programPath, candidate.argv(dir), dir));
    }

    if (detectWsl(host.platform, host.env, host.release)) {
        const distro = host.env.WSL_DISTRO_NAME;
        const comspecName = host.env.ComSpec !== undefined && host.env.ComSpec !== '' ? host.env.ComSpec : 'cmd.exe';
        const comspec = distro !== undefined && distro !== '' ? resolve(comspecName) : null;
        if (comspec !== null) specs.push(wslFallbackSpec(comspec, dir, distro as string));
    }

    return { specs };
}
