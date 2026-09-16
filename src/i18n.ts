/**
 * UI language resolution and strings for `/term`.
 *
 * The chain is the one dsh-TUI itself uses, so `/lang` is honoured without a
 * restart:
 *
 *   `DSH_TUI_LANG` → the live `dsh-tui` settings namespace (passed in by the
 *   caller, which owns the seam) → `~/.dsh-tui/lang.json` → the OS locale →
 *   `zh`, the language this plugin's replies were originally written in.
 *
 * A locale that is present but unsupported falls back to `en` (dsh-TUI's own
 * rule); a *missing* locale keeps `zh`, so a Chinese host that never wrote a
 * preference renders exactly as it did before this module existed.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The two languages this plugin can render. */
export type Lang = 'zh' | 'en';

/** Path of the preference file dsh-TUI writes on `/lang`. */
export function langFilePath(env: NodeJS.ProcessEnv = process.env): string {
    const override = typeof env.DSH_OPEN_TERMINAL_LANG_FILE === 'string' && env.DSH_OPEN_TERMINAL_LANG_FILE !== ''
        ? env.DSH_OPEN_TERMINAL_LANG_FILE
        : undefined;
    if (override !== undefined) return override;
    const dir = typeof env.DSH_TUI_STATE_DIR === 'string' && env.DSH_TUI_STATE_DIR !== ''
        ? env.DSH_TUI_STATE_DIR
        : join(homedir(), '.dsh-tui');
    return join(dir, 'lang.json');
}

/**
 * Normalize one raw preference value; `undefined` means "no information".
 *
 * Languages arrive in every shape the ecosystem produces (`zh`, `zh-CN`,
 * `zh_CN.UTF-8`, `en_GB@euro`), so the language is read as the head before the
 * first separator rather than through a per-spelling table.
 */
export function normalizeLang(value: unknown): Lang | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim().toLowerCase();
    if (text === '') return undefined;
    const head = text.split(/[_.\-@]/u)[0];
    if (head === 'zh') return 'zh';
    if (head === 'en') return 'en';
    return undefined;
}

/** A present-but-unsupported locale is English, not "no information". */
function localePrefers(locale: unknown): Lang | undefined {
    if (typeof locale !== 'string' || locale.trim() === '') return undefined;
    return normalizeLang(locale) ?? 'en';
}

/** Read `~/.dsh-tui/lang.json`; any problem reads as "no information". */
function langFromFile(env: NodeJS.ProcessEnv): Lang | undefined {
    try {
        const parsed = JSON.parse(readFileSync(langFilePath(env), 'utf8')) as { lang?: unknown };
        return normalizeLang(parsed?.lang);
    }
    catch {
        return undefined;
    }
}

/** Everything {@link resolveLang} needs, all injectable for tests. */
export interface LangSources {
    /** Live value from the host's `dsh-tui` settings namespace. */
    settingsLang?: unknown;
    env?: NodeJS.ProcessEnv;
    /** Process locale, e.g. `process.env.LANG`. */
    locale?: unknown;
    /** File reader override (tests). */
    readLangFile?: (env: NodeJS.ProcessEnv) => Lang | undefined;
}

/** Resolve the language to render with; never throws. */
export function resolveLang(sources: LangSources = {}): Lang {
    const env = sources.env ?? process.env;
    const fromEnv = normalizeLang(env.DSH_TUI_LANG);
    if (fromEnv !== undefined) return fromEnv;
    const fromSettings = normalizeLang(sources.settingsLang);
    if (fromSettings !== undefined) return fromSettings;
    const reader = sources.readLangFile ?? langFromFile;
    let fromFile: Lang | undefined;
    try {
        fromFile = reader(env);
    }
    catch {
        fromFile = undefined;
    }
    if (fromFile !== undefined) return fromFile;
    return localePrefers(sources.locale ?? env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG) ?? 'zh';
}

/**
 * Every string this plugin renders.
 *
 * `{name}` placeholders are substituted by {@link t}; both dictionaries carry
 * the same key set, and `test/i18n.test.ts` pins that.
 */
const STRINGS: Record<Lang, Record<string, string>> = {
    zh: {
        commandDescription: '在当前工作目录、指定文件夹或工作区里模糊找到的文件夹中打开系统终端',
        commandHint: '<文件夹名片段>（留空 = 在工作目录根开终端）',
        hintWindows: '请确认已安装 Windows Terminal（wt.exe）、PowerShell 或 cmd，或用配置 command 指定终端',
        hintMac: '请确认 /usr/bin/open 与 Terminal.app 可用，或用配置 command 指定终端',
        hintLinux: '请安装任一终端模拟器（gnome-terminal / kgx / konsole / xfce4-terminal / kitty / alacritty / wezterm / xterm…），或用配置 command 指定终端',
        dirMissing: '目录不存在：{dir}',
        noGraphicalSession: '当前环境没有图形会话，无法打开终端',
        noTerminalFound: '找不到可用的终端程序（{hint}）',
        opened: '已在 {dir} 打开终端（{launcher}）',
        openFailed: '无法在 {dir} 打开终端（已尝试 {attempted}，均失败；{hint}）',
        notAFolder: '{target} 是文件，不是文件夹（/term 只在文件夹打开终端）',
        noFolderMatch: '工作区中找不到与 “{query}” 相关的文件夹（留空参数可在工作目录根打开终端）',
        dirTag: '[目录] {path}',
        listSeparator: '、',
        moreItems: ' 等 {count} 项',
        noDialogCandidates: '找到 {count} 个匹配，但当前环境没有对话框选择，请键入更精确的路径。候选：{preview}{more}',
        dialogTitleTruncated: '在哪个文件夹打开终端？（{query} · 共 {count} 个匹配，仅显示前 {shown} 个）',
        dialogTitle: '在哪个文件夹打开终端？（{query} · {count} 个匹配）',
        targetStale: '无法在 {target} 打开终端（目标已失效）',
    },
    en: {
        commandDescription: 'Open the system terminal in the working directory, a given folder, or a folder fuzzy-found in the workspace',
        commandHint: '<folder name fragment> (blank = the working directory)',
        hintWindows: 'check that Windows Terminal (wt.exe), PowerShell or cmd is installed, or set `command` to the terminal you want',
        hintMac: 'check that /usr/bin/open and Terminal.app are available, or set `command` to the terminal you want',
        hintLinux: 'install a terminal emulator (gnome-terminal / kgx / konsole / xfce4-terminal / kitty / alacritty / wezterm / xterm …), or set `command` to the terminal you want',
        dirMissing: 'directory does not exist: {dir}',
        noGraphicalSession: 'no graphical session is available, so no terminal can be opened',
        noTerminalFound: 'no usable terminal program found ({hint})',
        opened: 'opened a terminal in {dir} ({launcher})',
        openFailed: 'cannot open a terminal in {dir} (tried {attempted}; all failed; {hint})',
        notAFolder: '{target} is a file, not a folder (/term only opens terminals in folders)',
        noFolderMatch: 'no workspace folder matches “{query}” (run it with no argument to use the working directory)',
        dirTag: '[dir] {path}',
        listSeparator: ', ',
        moreItems: ' and {count} more',
        noDialogCandidates: 'found {count} matches, but no dialog is available here — type a more specific path. Candidates: {preview}{more}',
        dialogTitleTruncated: 'open a terminal in which folder? ({query} · {count} matches, showing the first {shown})',
        dialogTitle: 'open a terminal in which folder? ({query} · {count} matches)',
        targetStale: 'cannot open a terminal in {target} (the target disappeared)',
    },
};

/** Every key either dictionary defines. */
export const STRING_KEYS: readonly string[] = Object.freeze(Object.keys(STRINGS.zh));

/**
 * Render one string.
 *
 * @param lang - resolved language.
 * @param key - a key from {@link STRING_KEYS}.
 * @param vars - `{name}` substitutions; a missing one is left as written, so a
 *   bug shows up as `{name}` on screen instead of `undefined`.
 */
export function t(lang: Lang, key: string, vars?: Record<string, string | number>): string {
    const table = STRINGS[lang] ?? STRINGS.zh;
    const template = table[key] ?? STRINGS.zh[key] ?? key;
    if (vars === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
        const value = vars[name];
        return value === undefined ? match : String(value);
    });
}
