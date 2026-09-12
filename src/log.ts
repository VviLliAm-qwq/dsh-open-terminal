/**
 * Bounded lifecycle diagnostics for dsh-open-terminal (SOP §2.2).
 *
 * The host keeps no plugin diagnostics, so "the host never loaded the file" /
 * "loaded but the seam refused the registration" / "registered but nothing
 * shows up" are only distinguishable if the plugin talks: every line goes to
 * `~/.dsh-tui/dsh-open-terminal.log`, trimmed to its newest half once it passes
 * {@link MAX_LOG_BYTES}. Test runners are suppressed — a suite that calls
 * `apply()` must not litter a user's home directory.
 *
 * @module dsh-open-terminal/log
 */
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Cordis row id / package name — also the log file stem. */
export const PLUGIN_NAME = 'dsh-open-terminal';

/** Above this size the log is trimmed to its newest half. */
export const MAX_LOG_BYTES = 128 * 1024;

/**
 * Diagnostic log file (ecosystem convention `~/.dsh-tui/<plugin>.log`).
 * Resolved lazily: a module-level `homedir()` throw would take the whole entry
 * down, and diagnostics are never worth a boot failure.
 */
export function diagLogPath(): string {
    return join(homedir(), '.dsh-tui', `${PLUGIN_NAME}.log`);
}

/**
 * Test runners must never write into a user's `~/.dsh-tui`. The SOP names
 * `node --test`; vitest is treated identically, since this suite calls
 * `apply()` on every run and would otherwise litter the log.
 */
export function diagnosticsEnabled(): boolean {
    return typeof process.env?.NODE_TEST_CONTEXT !== 'string' && process.env?.VITEST === undefined;
}

/**
 * Append one diagnostic line, keeping the file bounded: past `MAX_LOG_BYTES`
 * the older half is dropped, so a long-lived session cannot grow the log
 * without bound.
 */
export function appendLogLine(path: string, line: string): void {
    try {
        if (statSync(path).size > MAX_LOG_BYTES) {
            const keep = readFileSync(path, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2));
            writeFileSync(path, keep);
        }
    }
    catch {
        // Missing or unreadable file: the append below recreates it.
    }
    appendFileSync(path, line);
}

/** Record the module-import line. Never throws: diagnostics are optional. */
export function recordModuleImport(entry: string): void {
    try {
        if (!diagnosticsEnabled()) return;
        appendLogLine(
            diagLogPath(),
            `${new Date().toISOString()} info module imported pid=${process.pid} node=${process.version} entry=${entry}\n`,
        );
    }
    catch {
        // Diagnostics must never be the reason a module fails to load.
    }
}

/** The host logger surface this plugin uses (structurally, never imported). */
export interface HostLoggerLike {
    info?(message: string): void;
    warn?(message: string): void;
}

/** The two-level logger the plugin uses internally. */
export interface Logger {
    info(message: string): void;
    warn(message: string): void;
}

/**
 * Lifecycle logger (SOP §2.2): host logger plus this plugin's own bounded file
 * log, so "host never loaded the file" / "loaded but the seam refused the
 * registration" / "registered but nothing shows up" are distinguishable from a
 * single log. Warnings are de-duplicated — the host may re-apply the plugin.
 */
export function createLogger(host: HostLoggerLike | undefined, seen: Set<string> = new Set<string>()): Logger {
    const write = (level: 'info' | 'warn', message: string): void => {
        if (level === 'warn') {
            if (seen.has(message)) return;
            seen.add(message);
        }
        try {
            host?.[level]?.(`${PLUGIN_NAME}: ${message}`);
        }
        catch {
            // Observability only; never let logging break the plugin.
        }
        if (!diagnosticsEnabled()) return;
        try {
            appendLogLine(diagLogPath(), `${new Date().toISOString()} ${level} ${message}\n`);
        }
        catch {
            // An unwritable log path is not an error worth surfacing.
        }
    };
    return {
        info: (message) => write('info', message),
        warn: (message) => write('warn', message),
    };
}
