import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DIALOG_MAX_OPTIONS,
    expandTilde,
    resolveSessionCwd,
    runTermCommand,
    spawnOnce,
    type TerminalCommandOptions,
    type TerminalDialogLike,
    type TerminalRuntime,
} from '../src/command.js';
import type { SpawnSpec } from '../src/terminal.js';

const OPTIONS: TerminalCommandOptions = {
    command: '',
    maxCandidates: 0,
    includeHidden: false,
    maxDepth: 6,
    maxEntries: 2000,
};

const cleanups: Array<() => void> = [];
afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
});

/** A throwaway workspace with a small folder tree. */
function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), 'dsh-open-terminal-cmd-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'alpha-two'));
    mkdirSync(join(root, 'beta'));
    mkdirSync(join(root, 'docs', 'guide'), { recursive: true });
    writeFileSync(join(root, 'notes.txt'), 'x');
    return root;
}

interface Harness {
    readonly runtime: TerminalRuntime;
    readonly spawns: SpawnSpec[];
}

/**
 * A Windows-flavoured runtime: the platform probe is stubbed (no real PATH
 * lookup), the spawn seam records specs instead of opening windows, and the
 * dialog is absent unless the test provides one.
 */
function windowsHarness(
    root: string,
    overrides: Partial<TerminalRuntime> = {},
    spawnResult: (spec: SpawnSpec) => boolean = () => true,
): Harness {
    const spawns: SpawnSpec[] = [];
    const runtime: TerminalRuntime = {
        cwd: root,
        platform: 'win32',
        env: { ComSpec: 'C:\\WINDOWS\\system32\\cmd.exe' } as NodeJS.ProcessEnv,
        release: '',
        resolveProgram: (name) =>
            (name === 'wt.exe' ? 'C:\\fake\\wt.exe' : name === 'pwsh.exe' ? 'C:\\fake\\pwsh.exe' : null),
        spawn: async (spec) => {
            spawns.push(spec);
            return spawnResult(spec);
        },
        ...overrides,
    };
    return { runtime, spawns };
}

function makeDialog(pick?: string): TerminalDialogLike & { select: ReturnType<typeof vi.fn> } {
    return { select: vi.fn(async () => pick) };
}

describe('resolveSessionCwd', () => {
    it('reads the live session header cwd — the TUI workspace', () => {
        expect(resolveSessionCwd({ session: { header: { cwd: 'D:\\ws-alpha' } } })).toBe('D:\\ws-alpha');
    });

    it('prefers the session header over the legacy meta alias', () => {
        expect(resolveSessionCwd({
            session: { header: { cwd: 'D:\\live' }, meta: { cwd: 'D:\\stale' } },
        })).toBe('D:\\live');
        expect(resolveSessionCwd({ session: { meta: { cwd: 'D:\\legacy' } } })).toBe('D:\\legacy');
    });

    it('falls back to the host process cwd without session metadata', () => {
        expect(resolveSessionCwd(undefined)).toBe(process.cwd());
        expect(resolveSessionCwd({})).toBe(process.cwd());
        expect(resolveSessionCwd({ session: { header: {} } })).toBe(process.cwd());
    });
});

describe('expandTilde', () => {
    it('expands ~, ~/… and ~\\… but leaves ~user alone', () => {
        expect(expandTilde('~', '/home/me')).toBe('/home/me');
        expect(expandTilde('~/docs', '/home/me')).toBe(join('/home/me', 'docs'));
        expect(expandTilde('~\\docs', '/home/me')).toBe(join('/home/me', 'docs'));
        expect(expandTilde('~root/docs', '/home/me')).toBe('~root/docs');
        expect(expandTilde('/abs/path', '/home/me')).toBe('/abs/path');
    });
});

describe('runTermCommand — opening', () => {
    it('opens the session working directory for a blank input', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root);
        const result = await runTermCommand('', runtime, OPTIONS);
        expect(result).toEqual({ kind: 'success', text: `已在 ${root} 打开终端（wt.exe）` });
        expect(spawns).toHaveLength(1);
        expect(spawns[0]!.args).toEqual(['-d', root]);
    });

    it('opens an exact neighbouring folder without scanning or asking', async () => {
        const root = workspace();
        const dialog = makeDialog('alpha');
        const { runtime, spawns } = windowsHarness(root, { dialogs: dialog });
        const result = await runTermCommand('beta', runtime, OPTIONS);
        expect(result.kind).toBe('success');
        expect(dialog.select).not.toHaveBeenCalled();
        expect(spawns[0]!.args).toEqual(['-d', join(root, 'beta')]);
    });

    it('opens a relative path that exists', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root);
        const result = await runTermCommand(join('docs', 'guide'), runtime, OPTIONS);
        expect(result.kind).toBe('success');
        expect(spawns[0]!.args).toEqual(['-d', join(root, 'docs', 'guide')]);
    });

    it('expands a leading ~ through the injected home directory', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root, { home: root });
        await runTermCommand('~/beta', runtime, OPTIONS);
        expect(spawns[0]!.args).toEqual(['-d', join(root, 'beta')]);
    });

    it('recovers a typo by fuzzy-matching the last path segment', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root);
        const result = await runTermCommand(`docs${'\\'}guid`, runtime, OPTIONS);
        expect(result.kind).toBe('success');
        expect(spawns[0]!.args).toEqual(['-d', join(root, 'docs', 'guide')]);
    });

    it('passes the configured command template through to the launch', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root);
        await runTermCommand('', runtime, { ...OPTIONS, command: 'wt.exe -p "Git Bash" -d {dir}' });
        expect(spawns).toHaveLength(1);
        expect(spawns[0]!.args[3]).toContain('"-p" "Git Bash"');
    });
});

describe('runTermCommand — errors', () => {
    it('refuses a file instead of opening a terminal', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root);
        const result = await runTermCommand('notes.txt', runtime, OPTIONS);
        expect(result.kind).toBe('error');
        expect(result.text).toContain('是文件，不是文件夹');
        expect(spawns).toHaveLength(0);
    });

    it('refuses a path-shaped file too', async () => {
        const root = workspace();
        const { runtime } = windowsHarness(root);
        // Built with the host separator: on POSIX a backslash is an ordinary
        // file-name character, so a hand-written `beta\..\notes.txt` would name
        // a (missing) single file instead of a path.
        const result = await runTermCommand(join('beta', '..', 'notes.txt'), runtime, OPTIONS);
        expect(result.text).toContain('是文件，不是文件夹');
    });

    it('reports no match for an unknown fragment', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root);
        const result = await runTermCommand('zzzz-nothing', runtime, OPTIONS);
        expect(result.kind).toBe('error');
        expect(result.text).toContain('找不到与');
        expect(result.text).toContain('留空参数');
        expect(spawns).toHaveLength(0);
    });

    it('reports a vanished working directory rather than pretending to open it', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root, { cwd: join(root, 'gone') });
        const result = await runTermCommand('', runtime, OPTIONS);
        expect(result).toEqual({ kind: 'error', text: `目录不存在：${join(root, 'gone')}` });
        expect(spawns).toHaveLength(0);
    });

    it('refuses to launch without a graphical session', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root, {
            platform: 'linux',
            env: {} as NodeJS.ProcessEnv,
            release: '5.15.0-generic',
        });
        const result = await runTermCommand('', runtime, OPTIONS);
        expect(result.text).toContain('没有图形会话');
        expect(spawns).toHaveLength(0);
    });

    it('reports when no terminal program exists at all', async () => {
        const root = workspace();
        const { runtime } = windowsHarness(root, { resolveProgram: () => null });
        const result = await runTermCommand('', runtime, OPTIONS);
        expect(result.text).toContain('找不到可用的终端程序');
    });

    it('surfaces a configuration error from the template', async () => {
        const root = workspace();
        const { runtime } = windowsHarness(root);
        const result = await runTermCommand('', runtime, { ...OPTIONS, command: 'cmd.exe /k echo %CD%' });
        expect(result.kind).toBe('error');
        expect(result.text).toContain('%');
    });
});

describe('runTermCommand — candidate fallback', () => {
    it('falls through to the next candidate when one fails', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root, {}, (spec) => spec.file !== 'C:\\fake\\wt.exe');
        const result = await runTermCommand('', runtime, OPTIONS);
        expect(spawns).toHaveLength(2);
        expect(result.kind).toBe('success');
        expect(result.text).toContain('pwsh.exe');
    });

    it('lists everything it tried when the whole chain fails', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root, {}, () => false);
        const result = await runTermCommand('', runtime, OPTIONS);
        expect(spawns).toHaveLength(2);
        expect(result.kind).toBe('error');
        expect(result.text).toContain('均失败');
        expect(result.text).toContain('wt.exe');
        expect(result.text).toContain('pwsh.exe');
    });
});

describe('runTermCommand — fuzzy picker', () => {
    it('asks through the managed dialog for several matches', async () => {
        const root = workspace();
        const dialog = makeDialog('alpha-two');
        const { runtime, spawns } = windowsHarness(root, { dialogs: dialog });
        const result = await runTermCommand('alph', runtime, OPTIONS);
        expect(result.kind).toBe('success');
        expect(dialog.select).toHaveBeenCalledTimes(1);
        const request = dialog.select.mock.calls[0]![0];
        expect(request.title).toContain('2 个匹配');
        expect(request.options.map((option) => option.id)).toEqual(['alpha', 'alpha-two']);
        expect(request.options[0]!.label).toContain('alpha');
        expect(request.options[0]!.description).toBe('alpha');
        expect(spawns[0]!.args).toEqual(['-d', join(root, 'alpha-two')]);
    });

    it('stays quiet when the picker is cancelled', async () => {
        const root = workspace();
        const dialog = makeDialog(undefined);
        const { runtime, spawns } = windowsHarness(root, { dialogs: dialog });
        const result = await runTermCommand('alph', runtime, OPTIONS);
        expect(result).toEqual({ kind: 'success' });
        expect(spawns).toHaveLength(0);
    });

    it('degrades to a candidate listing without the dialog seam', async () => {
        const root = workspace();
        const { runtime, spawns } = windowsHarness(root);
        const result = await runTermCommand('alph', runtime, OPTIONS);
        expect(result.kind).toBe('error');
        expect(result.text).toContain('没有对话框选择');
        expect(result.text).toContain('alpha');
        expect(spawns).toHaveLength(0);
    });

    it('opens the only match without asking', async () => {
        const root = workspace();
        const dialog = makeDialog('alpha');
        const { runtime, spawns } = windowsHarness(root, { dialogs: dialog });
        const result = await runTermCommand('docs', runtime, OPTIONS);
        expect(result.kind).toBe('success');
        expect(dialog.select).not.toHaveBeenCalled();
        expect(spawns[0]!.args).toEqual(['-d', join(root, 'docs')]);
    });

    it('caps one dialog request at the host ceiling and says what it dropped', async () => {
        const root = workspace();
        for (let index = 0; index < 101; index += 1) {
            mkdirSync(join(root, `proj-${String(index).padStart(3, '0')}`));
        }
        const dialog = makeDialog(undefined);
        const { runtime } = windowsHarness(root, { dialogs: dialog });
        await runTermCommand('proj', runtime, OPTIONS);
        const request = dialog.select.mock.calls[0]![0];
        expect(request.options).toHaveLength(DIALOG_MAX_OPTIONS);
        expect(request.title).toContain('101 个匹配');
        expect(request.title).toContain('前 100 个');
    });

    it('honours a positive maxCandidates cap without claiming truncation', async () => {
        const root = workspace();
        for (let index = 0; index < 20; index += 1) {
            mkdirSync(join(root, `proj-${String(index).padStart(3, '0')}`));
        }
        const dialog = makeDialog(undefined);
        const { runtime } = windowsHarness(root, { dialogs: dialog });
        await runTermCommand('proj', runtime, { ...OPTIONS, maxCandidates: 3 });
        const request = dialog.select.mock.calls[0]![0];
        expect(request.options).toHaveLength(3);
        expect(request.title).toContain('3 个匹配');
        expect(request.title).not.toContain('仅显示');
    });
});

describe('spawnOnce', () => {
    const base = { windowsHide: true, detached: false, windowsVerbatimArguments: false };

    it('counts a clean exit as a successful hand-off', async () => {
        expect(await spawnOnce({ ...base, file: process.execPath, args: ['-e', 'process.exit(0)'] })).toBe(true);
    });

    it('counts a fast non-zero exit as a failure so the next candidate runs', async () => {
        expect(await spawnOnce({ ...base, file: process.execPath, args: ['-e', 'process.exit(3)'] })).toBe(false);
    });

    it('counts a spawn error as a failure', async () => {
        expect(await spawnOnce({ ...base, file: 'definitely-missing-program-xyz', args: [] })).toBe(false);
    });
});
