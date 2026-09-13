/**
 * dsh-open-terminal — implementation module.
 *
 * `/term` opens a system terminal in a workspace folder: blank opens the
 * session working directory, a fragment fuzzy-matches the workspace's folders
 * and offers them in the host's managed picker when several match. The actual
 * decision tree lives in `./command.js`, the platform chains in `./terminal.js`;
 * this module only owns the Cordis contract (name / Config / apply), the seam
 * probing and the lifecycle log.
 *
 * The host-facing entry is `./index.js`, a shell that re-exports exactly
 * `{ Config, apply, name }` (SOP §2.1): a module namespace carrying extra
 * symbols changes how the loader wraps the activation, and the dsh-tui seams
 * then silently refuse its registrations.
 *
 * @module dsh-open-terminal/plugin
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import {
    resolveSessionCwd,
    runTermCommand,
    type CommandInvocationLike,
    type CommandResultLike,
    type TerminalCommandOptions,
    type TerminalDialogLike,
} from './command.js';
import { createLogger, recordModuleImport, type HostLoggerLike } from './log.js';
import { DEFAULT_LIMITS } from './scan.js';
import { resolveLang, t } from './i18n.js';

/** Cordis row id used for the plugin. */
export const name = 'dsh-open-terminal';

/**
 * Plugin configuration (all keys have defaults; a missing config degrades to
 * the defaults — it must never fail the TUI boot).
 */
export type Config = {
    /**
     * Launch template used instead of the built-in per-platform chain, with
     * `{dir}` standing for the target folder — e.g. `wt.exe -p "Git Bash" -d
     * {dir}` or `gnome-terminal --working-directory={dir}`. Empty (the default)
     * uses the chain. When set, the template IS the answer: a program that
     * cannot be resolved is a clear error, never a silent substitution.
     */
    command?: string;
    /** Maximum folder depth walked (root = 0). */
    maxDepth?: number;
    /** Maximum number of folders collected. */
    maxEntries?: number;
    /** Max candidates offered in the select dialog; `0` = every match (unlimited). */
    maxCandidates?: number;
    /** Include hidden (dot) folders in the fuzzy index. */
    includeHidden?: boolean;
};

export const Config: Schemastery<Config> = z.object({
    command: z.string().default(''),
    maxDepth: z.number().min(0).default(DEFAULT_LIMITS.maxDepth),
    maxEntries: z.number().min(1).default(DEFAULT_LIMITS.maxEntries),
    // schemastery has no .integer(); slice() truncates decimals anyway.
    // `0` is the default and means "no plugin-side cap": the managed dialog is
    // windowed and scrolls (↑/↓), so hiding matches buys nothing. Values ≤ 0
    // are treated as unlimited by the ranker as well, so a stray -1 can never
    // produce an empty picker.
    maxCandidates: z.number().min(0).default(0),
    includeHidden: z.boolean().default(false),
});

recordModuleImport(import.meta.url);

/**
 * Structural subset of `@deepseek-ai/dsh-commands` `CommandDefinition` —
 * intentionally NOT imported so the plugin stays decoupled from the upstream
 * package version (a drift in dsh-commands must never break this plugin).
 */
export interface CommandDefinitionLike {
    readonly name: string;
    readonly description: string;
    /** Localized descriptions the host renders itself (English is the fallback). */
    readonly descriptions?: { readonly zh?: string; readonly en?: string };
    readonly input?: { readonly hint: string };
    readonly handler: (invocation: CommandInvocationLike) => CommandResultLike | Promise<CommandResultLike>;
}

/** Structural subset of `ctx.tuiPluginHost` (C-041 mediated registration). */
export interface PluginHostLike {
    registerCommand(pluginCtx: unknown, definition: CommandDefinitionLike): () => void;
}

/** Structural subset of the direct `commands` service (C-070 boundary). */
export interface CommandsLike {
    register(definition: CommandDefinitionLike): () => void;
}

/** `0` = absent, `1` = present (the SOP's seam-probe notation). */
function seamState(value: unknown): number {
    return value === undefined || value === null ? 0 : 1;
}

/** Effective command options from the resolved config. */
function effectiveOptions(config: Config): TerminalCommandOptions {
    return {
        command: (config.command ?? '').trim(),
        maxCandidates: config.maxCandidates ?? 0,
        includeHidden: config.includeHidden ?? false,
        maxDepth: config.maxDepth ?? DEFAULT_LIMITS.maxDepth,
        maxEntries: config.maxEntries ?? DEFAULT_LIMITS.maxEntries,
    };
}

/**
 * Wire the plugin: register `/term` through the host-mediated command surface
 * (C-041) with a direct-services fallback (C-070). Failures log and degrade —
 * a registration problem must never take the TUI down.
 */
export function apply(ctx: Context, config: Config = {}): void {
    const options = effectiveOptions(config);
    const log = createLogger(ctx.logger as unknown as HostLoggerLike | undefined);
    /**
     * The host's live language preference (`dsh-tui.lang`), or undefined.
     *
     * Read through the public `settings.get(ns)` seam and defensively: a host
     * without that namespace must still render in the historical default.
     */
    const settingsLang = (): unknown => {
        try {
            const settings = ctx.get('settings', false) as { get?: (ns: string) => unknown } | undefined;
            const section = settings?.get?.('dsh-tui') as { lang?: unknown } | undefined;
            return section?.lang;
        }
        catch {
            return undefined;
        }
    };
    log.info(`apply start pid=${process.pid} entry=${import.meta.url}`);
    log.info(
        `config command=${options.command === '' ? '(auto chain)' : JSON.stringify(options.command)}`
        + ` maxDepth=${options.maxDepth} maxEntries=${options.maxEntries}`
        + ` maxCandidates=${options.maxCandidates} includeHidden=${options.includeHidden}`,
    );

    const definition: CommandDefinitionLike = {
        name: 'term',
        // The host localizes `descriptions` itself, so both languages ride along;
        // `description` stays the English fallback for a host that does not.
        description: t('en', 'commandDescription'),
        descriptions: {
            zh: t('zh', 'commandDescription'),
            en: t('en', 'commandDescription'),
        },
        input: { hint: t(resolveLang({ settingsLang: settingsLang() }), 'commandHint') },
        handler: async (invocation) => {
            const cwd = resolveSessionCwd(invocation.agent);
            const dialogs = ctx.get('tuiDialogs', false) as TerminalDialogLike | undefined;
            // Resolved per call, so a `/lang` switch reaches every reply without a
            // restart; the registered hint above is a snapshot the host cannot refresh.
            const lang = resolveLang({ settingsLang: settingsLang() });
            return runTermCommand(
                invocation.rawInput,
                { cwd, dialogs, signal: invocation.signal, lang },
                options,
            );
        },
    };

    let host: PluginHostLike | undefined;
    let commands: CommandsLike | undefined;
    try {
        host = ctx.get('tuiPluginHost', false) as PluginHostLike | undefined;
        // Probed for the log even when the mediated surface wins: a support
        // session needs to see which surfaces the host actually offers.
        commands = ctx.get('commands', false) as CommandsLike | undefined;
        log.info(`seams tuiPluginHost=${seamState(host)} commands=${seamState(commands)} tuiDialogs=${seamState(ctx.get('tuiDialogs', false))}`);
    }
    catch (error) {
        log.warn(`seam probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    let dispose: (() => void) | undefined;
    try {
        if (host !== undefined) {
            // Mediated path: stamps verified component identity + invoke checkpoint.
            dispose = host.registerCommand(ctx, definition);
        }
        else {
            const fallback = commands ?? (ctx.get('commands', false) as CommandsLike | undefined);
            dispose = fallback?.register(definition);
        }
    }
    catch (error) {
        // DUPLICATE_CONTRIBUTION_ID or an absent commands service: log, skip.
        log.warn(`command registration failed: ${error instanceof Error ? error.message : String(error)}`);
        return;
    }

    if (dispose === undefined) {
        log.warn('no command service available — /term is not registered');
        return;
    }

    log.info(`command registered name=term via=${host !== undefined ? 'tuiPluginHost' : 'commands'} cwd-source=session-header`);
    ctx.effect(() => () => {
        log.info('command disposed — /term is no longer registered');
        (dispose as () => void)();
    }, 'dsh-open-terminal command');
}
