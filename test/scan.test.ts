import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scanFolders, type ScanLimits } from '../src/scan.js';

const LIMITS: ScanLimits = { maxDepth: 6, maxEntries: 2000, includeHidden: false };

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
});

/** A throwaway workspace root, removed after the test. */
function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-open-terminal-scan-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

/** Make a directory, creating parents. */
function dir(root: string, relPath: string): string {
    const target = join(root, ...relPath.split('/'));
    mkdirSync(target, { recursive: true });
    return target;
}

describe('scanFolders', () => {
    it('indexes folders only — files are not candidates', async () => {
        const root = workspace();
        writeFileSync(join(root, 'a.txt'), 'a');
        dir(root, 'src');
        dir(root, 'docs');
        const folders = await scanFolders(root, LIMITS);
        expect(folders.map((entry) => entry.relPath)).toEqual(['docs', 'src']);
        expect(folders.every((entry) => entry.isDir)).toBe(true);
    });

    it('walks nested folders with /-separated relative paths', async () => {
        const root = workspace();
        dir(root, 'src/plugins/terminal');
        const folders = await scanFolders(root, LIMITS);
        expect(folders.map((entry) => entry.relPath)).toEqual(['src', 'src/plugins', 'src/plugins/terminal']);
        const nested = folders.find((entry) => entry.relPath === 'src/plugins/terminal');
        expect(nested?.absPath).toBe(join(root, 'src', 'plugins', 'terminal'));
        expect(nested?.basename).toBe('terminal');
    });

    it('never walks generated or tool-state directories', async () => {
        const root = workspace();
        dir(root, 'node_modules/pkg');
        dir(root, 'dist');
        dir(root, '.git/objects');
        dir(root, 'keep');
        const folders = await scanFolders(root, LIMITS);
        expect(folders.map((entry) => entry.relPath)).toEqual(['keep']);
    });

    it('stops descending past the depth cap', async () => {
        const root = workspace();
        dir(root, 'a/b/c/d');
        const shallow = await scanFolders(root, { ...LIMITS, maxDepth: 1 });
        expect(shallow.map((entry) => entry.relPath)).toEqual(['a', 'a/b']);
        const deep = await scanFolders(root, { ...LIMITS, maxDepth: 6 });
        expect(deep.map((entry) => entry.relPath)).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/d']);
    });

    it('stops collecting at the entry cap', async () => {
        const root = workspace();
        for (const name of ['a', 'b', 'c', 'd', 'e']) dir(root, name);
        const folders = await scanFolders(root, { ...LIMITS, maxEntries: 2 });
        expect(folders).toHaveLength(2);
    });

    it('skips dot-folders unless hidden entries are requested', async () => {
        const root = workspace();
        dir(root, '.hidden/deep');
        dir(root, 'visible');
        expect((await scanFolders(root, LIMITS)).map((entry) => entry.relPath)).toEqual(['visible']);
        expect((await scanFolders(root, { ...LIMITS, includeHidden: true })).map((entry) => entry.relPath))
            .toEqual(['.hidden', '.hidden/deep', 'visible']);
    });

    it('indexes a linked folder but does not descend into it', async () => {
        const root = workspace();
        const target = dir(root, 'real/inside');
        const link = join(root, 'linked');
        try {
            symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
        }
        catch {
            return; // no symlink privilege on this machine — nothing to assert
        }
        const folders = await scanFolders(root, LIMITS);
        const relPaths = folders.map((entry) => entry.relPath);
        expect(relPaths).toContain('linked');
        // Cycle- and escape-proofing: the link is a candidate, not a doorway.
        expect(relPaths.filter((relPath) => relPath.startsWith('linked/'))).toEqual([]);
        expect(relPaths).toContain('real/inside');
    });

    it('returns nothing for an already-aborted signal', async () => {
        const root = workspace();
        dir(root, 'a/b');
        const controller = new AbortController();
        controller.abort();
        expect(await scanFolders(root, LIMITS, controller.signal)).toEqual([]);
    });

    it('degrades quietly when the root does not exist', async () => {
        const root = join(tmpdir(), 'dsh-open-terminal-missing-root-xyz');
        expect(await scanFolders(root, LIMITS)).toEqual([]);
    });
});
