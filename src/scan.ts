/**
 * Workspace folder index for dsh-open-terminal.
 *
 * Async recursive walk with hard caps so a huge repository cannot hang the
 * command: depth limit, total-entry limit, ignored-directory allowlist,
 * hidden-folder skip, and cooperative AbortSignal checks. Best effort only —
 * unreadable directories are skipped silently, never fatal.
 *
 * Folders only: `/term` opens a terminal in a directory, so indexing files
 * would only offer choices the command cannot honour. The walk still descends
 * through every non-ignored directory to find nested folders.
 *
 * Provenance: the traversal strategy (caps, ignore list, symlink handling,
 * cooperative yields) is the one shipped by the sibling plugin
 * `dsh-open-path`; keeping the two identical means `/open` and `/term` agree
 * on what "the workspace" contains. It stays a private copy rather than a
 * cross-plugin import — dsh-TUI plugins are independent bundles.
 *
 * @module dsh-open-terminal/scan
 */
import { statSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

/** One indexed workspace folder. */
export interface ScannedFolder {
    readonly relPath: string;
    readonly absPath: string;
    readonly isDir: boolean;
    readonly basename: string;
}

/** Scan hard limits and filters. */
export interface ScanLimits {
    /** Maximum directory depth walked (root = 0). */
    readonly maxDepth: number;
    /** Maximum number of folders collected. */
    readonly maxEntries: number;
    /** Include dot-directories. */
    readonly includeHidden: boolean;
}

export const DEFAULT_LIMITS: ScanLimits = {
    maxDepth: 6,
    maxEntries: 20000,
    includeHidden: false,
};

/**
 * Directories that are never walked. Everything here is either generated,
 * vendored, or tool-state: a fuzzy `/term` should not suggest them.
 */
export const IGNORED_DIRS = new Set([
    '.git',
    '.hg',
    '.svn',
    '.dsh',
    '.dsh-tui',
    '.dsh-memory',
    'node_modules',
    'bower_components',
    'dist',
    'build',
    'out',
    'target',
    '.next',
    '.nuxt',
    '.svelte-kit',
    'coverage',
    '.nyc_output',
    '.turbo',
    '.cache',
    '.pnpm-store',
    '.venv',
    'venv',
    '__pycache__',
    '.mypy_cache',
    '.idea',
    '.vscode',
    '.vs',
]);

/**
 * Walk `root` and collect candidate folders.
 *
 * @returns folders sorted by relative path (stable ordering for tests).
 */
export async function scanFolders(
    root: string,
    limits: ScanLimits = DEFAULT_LIMITS,
    signal?: AbortSignal,
): Promise<ScannedFolder[]> {
    const folders: ScannedFolder[] = [];
    let count = 0;
    let stopped = false;

    const walk = async (dirPath: string, depth: number): Promise<void> => {
        if (stopped || (signal?.aborted ?? false)) {
            stopped = true;
            return;
        }
        if (depth > limits.maxDepth) return;
        let dir;
        try {
            dir = await opendir(dirPath);
        }
        catch {
            return; // unreadable / vanished — skip silently
        }
        try {
            for await (const entry of dir) {
                if (stopped || (signal?.aborted ?? false)) {
                    stopped = true;
                    return;
                }
                if (!limits.includeHidden && entry.name.startsWith('.')) continue;
                const absPath = join(dirPath, entry.name);
                // A symlink to a directory reports isDirectory() === false on
                // every platform, which used to hide symlinked folders from the
                // index. One stat resolves the real kind; symlinked directories
                // are indexed but NOT descended into, which keeps the walk
                // cycle-free and inside the workspace.
                const isSymlink = entry.isSymbolicLink();
                let isDir = entry.isDirectory();
                if (!isDir && isSymlink) {
                    try {
                        isDir = statSync(absPath).isDirectory();
                    }
                    catch {
                        isDir = false; // dangling link — not a folder
                    }
                }
                if (!isDir) continue;
                if (IGNORED_DIRS.has(entry.name)) continue;

                const relPath = relative(root, absPath).split(sep).join('/');
                folders.push({ relPath, absPath, isDir: true, basename: basename(absPath) });
                count += 1;
                if (count >= limits.maxEntries) {
                    stopped = true;
                    return;
                }
                // Cooperative yield every few hundred folders so the event loop
                // (and the TUI) stays responsive on huge trees.
                if ((count & 255) === 0) {
                    await new Promise((resolve) => setImmediate(resolve));
                }
                if (!isSymlink) {
                    await walk(absPath, depth + 1);
                }
            }
        }
        catch {
            // aborted mid-iteration or read error — keep what we have
        }
    };

    await walk(root, 0);
    folders.sort((left, right) => (left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0));
    return folders;
}
