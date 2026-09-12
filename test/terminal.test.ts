import { lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    buildTerminalChain,
    carriesDirPlaceholder,
    currentHost,
    detectWsl,
    executableProbe,
    hasGraphicalSession,
    parseLaunchTemplate,
    pathExtensions,
    quoteForCmd,
    resolveProgram,
    substituteTemplateTokens,
    terminalHint,
    wslUncPath,
    type LaunchHost,
} from '../src/terminal.js';

/** A PATH probe driven by a fixed set of "existing" paths. */
function probe(paths: readonly string[]): (path: string) => boolean {
    const set = new Set(paths);
    return (path: string) => set.has(path);
}

const DIR = 'C:\\work\\my project';

const winHost = (env: NodeJS.ProcessEnv = {}): LaunchHost => ({ platform: 'win32', env, release: '' });
const darwinHost = (env: NodeJS.ProcessEnv = {}): LaunchHost => ({ platform: 'darwin', env, release: '' });
const linuxHost = (env: NodeJS.ProcessEnv = {}): LaunchHost => ({ platform: 'linux', env, release: '' });

describe('resolveProgram', () => {
    it('walks PATH in order and returns the first hit', () => {
        const env = { PATH: 'C:\\bin;C:\\other', PATHEXT: '.EXE' };
        expect(resolveProgram('wt.exe', {
            platform: 'win32',
            env,
            isExecutable: probe(['C:\\bin\\wt.exe', 'C:\\other\\wt.exe']),
        })).toBe('C:\\bin\\wt.exe');
    });

    it('appends PATHEXT suffixes so a bare name resolves to tool.CMD', () => {
        const env = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.CMD' };
        expect(resolveProgram('tool', { platform: 'win32', env, isExecutable: probe(['C:\\bin\\tool.CMD']) }))
            .toBe('C:\\bin\\tool.CMD');
    });

    it('falls back to the default PATHEXT when the variable is unset', () => {
        expect(pathExtensions(undefined)).toContain('.EXE');
        expect(resolveProgram('tool', {
            platform: 'win32',
            env: { PATH: 'C:\\bin' },
            isExecutable: probe(['C:\\bin\\tool.EXE']),
        })).toBe('C:\\bin\\tool.EXE');
    });

    it('strips the quotes some Windows PATH entries carry', () => {
        expect(resolveProgram('tool.exe', {
            platform: 'win32',
            env: { PATH: '"C:\\Program Files\\bin"', PATHEXT: '.EXE' },
            isExecutable: probe(['C:\\Program Files\\bin\\tool.exe']),
        })).toBe('C:\\Program Files\\bin\\tool.exe');
    });

    it('ignores empty PATH entries and tolerates a trailing separator', () => {
        expect(resolveProgram('kitty', {
            platform: 'linux',
            env: { PATH: '::/usr/bin/' },
            isExecutable: probe(['/usr/bin/kitty']),
        })).toBe('/usr/bin/kitty');
    });

    it('splits PATH on ":" on POSIX and on ";" on Windows', () => {
        expect(resolveProgram('xterm', {
            platform: 'darwin',
            env: { PATH: '/opt/bin:/usr/bin' },
            isExecutable: probe(['/usr/bin/xterm']),
        })).toBe('/usr/bin/xterm');
        expect(resolveProgram('xterm.exe', {
            platform: 'win32',
            env: { PATH: 'C:\\opt;C:\\usr\\bin', PATHEXT: '.EXE' },
            isExecutable: probe(['C:\\usr\\bin\\xterm.exe']),
        })).toBe('C:\\usr\\bin\\xterm.exe');
    });

    it('treats a name carrying a separator as a path, never a PATH lookup', () => {
        const env = { PATH: 'C:\\bin', PATHEXT: '.EXE' };
        expect(resolveProgram('C:\\tools\\wt.exe', { platform: 'win32', env, isExecutable: probe(['C:\\tools\\wt.exe']) }))
            .toBe('C:\\tools\\wt.exe');
        expect(resolveProgram('C:\\tools\\wt.exe', {
            platform: 'win32',
            env,
            isExecutable: probe(['C:\\bin\\C:\\tools\\wt.exe']),
        })).toBeNull();
    });

    it('returns null when nothing matches or the input is empty', () => {
        expect(resolveProgram('nope', { platform: 'linux', env: { PATH: '/usr/bin' }, isExecutable: () => false })).toBeNull();
        expect(resolveProgram('', { platform: 'linux', env: { PATH: '/usr/bin' }, isExecutable: () => true })).toBeNull();
        expect(resolveProgram('x', { platform: 'linux', env: {}, isExecutable: () => true })).toBeNull();
        expect(resolveProgram('   ', { platform: 'linux', env: { PATH: '/usr/bin' }, isExecutable: () => true })).toBeNull();
    });
});

describe('executableProbe', () => {
    const real = executableProbe(process.platform);
    const here = fileURLToPath(new URL('.', import.meta.url));

    it('rejects directories and missing paths, accepts a real executable', () => {
        expect(real(here)).toBe(false);
        expect(real(join(here, 'definitely-missing-xyz'))).toBe(false);
        expect(real(process.execPath)).toBe(true);
    });

    it('sees a Windows app-execution alias that statSync cannot follow', () => {
        const alias = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe');
        let present = false;
        try {
            present = !lstatSync(alias).isDirectory();
        }
        catch {
            present = false;
        }
        if (!present) return; // no such alias on this machine — nothing to assert
        // The trap this probe exists for: `statSync` throws EACCES on an
        // APPEXECLINK reparse point and `existsSync` reports it as missing,
        // while `lstatSync` (and therefore this probe) succeeds.
        expect(executableProbe('win32')(alias)).toBe(true);
    });
});

describe('parseLaunchTemplate', () => {
    it('splits on whitespace and keeps quoted groups together', () => {
        expect(parseLaunchTemplate('wt.exe -p "Git Bash" -d {dir}').tokens)
            .toEqual(['wt.exe', '-p', 'Git Bash', '-d', '{dir}']);
        expect(parseLaunchTemplate("--title='my shell'").tokens).toEqual(['--title=my shell']);
    });

    it('accepts {dir} standalone or glued into a flag', () => {
        expect(parseLaunchTemplate('gnome-terminal --working-directory={dir}').tokens)
            .toEqual(['gnome-terminal', '--working-directory={dir}']);
    });

    it('rejects empty, unterminated and forbidden templates', () => {
        expect(parseLaunchTemplate('   ').error).toContain('为空');
        expect(parseLaunchTemplate('wt.exe "unterminated').error).toContain('引号');
        expect(parseLaunchTemplate('cmd.exe /k echo %CD%').error).toContain('%');
        expect(parseLaunchTemplate('wt.exe -d {cwd}').error).toContain('{cwd}');
        expect(parseLaunchTemplate('').error).toBeDefined();
    });
});

describe('template substitution', () => {
    it('replaces {dir} standalone or inline and leaves other tokens alone', () => {
        expect(substituteTemplateTokens(['-d', '{dir}'], DIR)).toEqual(['-d', DIR]);
        expect(substituteTemplateTokens(['--working-directory={dir}'], '/tmp/x')).toEqual(['--working-directory=/tmp/x']);
        expect(substituteTemplateTokens(['-a', 'Terminal'], '/x')).toEqual(['-a', 'Terminal']);
    });

    it('detects whether the template carries the directory itself', () => {
        expect(carriesDirPlaceholder(['-d', '{dir}'])).toBe(true);
        expect(carriesDirPlaceholder(['--working-directory={dir}'])).toBe(true);
        expect(carriesDirPlaceholder(['-a', 'Terminal'])).toBe(false);
    });
});

describe('buildTerminalChain — Windows', () => {
    const comspec = 'C:\\WINDOWS\\system32\\cmd.exe';
    const resolveWindows = (name: string): string | null =>
        (['wt.exe', 'pwsh.exe', 'cmd.exe'].includes(name) ? `C:\\fake\\${name}` : null);

    it('offers only the programs that exist, in preference order', () => {
        const plan = buildTerminalChain({ dir: DIR, host: winHost({ ComSpec: comspec }), resolve: resolveWindows });
        expect(plan.error).toBeUndefined();
        expect(plan.specs.map((spec) => spec.label)).toEqual(['wt.exe', 'pwsh.exe', 'cmd.exe']);
    });

    it('spawns wt.exe directly so it opens and reports its own window', () => {
        const plan = buildTerminalChain({ dir: DIR, host: winHost({ ComSpec: comspec }), resolve: resolveWindows });
        expect(plan.specs[0]).toMatchObject({
            file: 'C:\\fake\\wt.exe',
            args: ['-d', DIR],
            cwd: DIR,
            detached: true,
            windowsVerbatimArguments: false,
        });
    });

    it('routes console shells through `cmd /c start` so they get a NEW window', () => {
        const plan = buildTerminalChain({ dir: DIR, host: winHost({ ComSpec: comspec }), resolve: resolveWindows });
        const spec = plan.specs[1]!;
        expect(spec.file).toBe(comspec);
        expect(spec.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
        expect(spec.args[3]).toBe('start "" "C:\\fake\\pwsh.exe"');
        expect(spec.windowsVerbatimArguments).toBe(true);
        expect(spec.cwd).toBe(DIR);
        expect(spec.label).toBe('pwsh.exe');
    });

    it('reports an empty chain when no terminal exists', () => {
        const plan = buildTerminalChain({ dir: DIR, host: winHost(), resolve: () => null });
        expect(plan.specs).toEqual([]);
        expect(plan.error).toBeUndefined();
    });

    it('treats a configured template as the whole answer', () => {
        const plan = buildTerminalChain({
            dir: DIR,
            template: 'wt.exe -p "Git Bash" -d {dir}',
            host: winHost({ ComSpec: comspec }),
            resolve: (name) => (name === 'wt.exe' ? 'C:\\fake\\wt.exe' : null),
        });
        expect(plan.specs).toHaveLength(1);
        expect(plan.specs[0]!.args[3]).toBe('start "" "C:\\fake\\wt.exe" "-p" "Git Bash" "-d" "C:\\work\\my project"');
    });

    it('falls back to the ComSpec default when the environment has none', () => {
        const plan = buildTerminalChain({
            dir: DIR,
            template: 'pwsh.exe',
            host: winHost(),
            resolve: () => 'C:\\fake\\pwsh.exe',
        });
        expect(plan.specs[0]!.file).toBe('cmd.exe');
    });

    it('fails loudly when the configured program is missing', () => {
        const plan = buildTerminalChain({ dir: DIR, template: 'kitty {dir}', host: winHost(), resolve: () => null });
        expect(plan.specs).toEqual([]);
        expect(plan.error).toContain('kitty');
    });

    it('surfaces template parse errors', () => {
        const plan = buildTerminalChain({
            dir: DIR,
            template: 'cmd.exe /k echo %CD%',
            host: winHost(),
            resolve: () => 'C:\\fake\\cmd.exe',
        });
        expect(plan.specs).toEqual([]);
        expect(plan.error).toContain('%');
    });
});

describe('buildTerminalChain — macOS', () => {
    it('opens Terminal.app at the folder', () => {
        const plan = buildTerminalChain({
            dir: '/Users/me/proj',
            host: darwinHost(),
            resolve: (name) => (name === 'open' ? '/usr/bin/open' : null),
        });
        expect(plan.specs).toHaveLength(1);
        expect(plan.specs[0]).toMatchObject({
            file: '/usr/bin/open',
            args: ['-a', 'Terminal', '/Users/me/proj'],
            cwd: '/Users/me/proj',
            windowsVerbatimArguments: false,
        });
    });
});

describe('buildTerminalChain — Linux', () => {
    it('walks the emulator preference order and passes the folder its own way', () => {
        const present = new Map<string, string>([
            ['gnome-terminal', '/usr/bin/gnome-terminal'],
            ['kitty', '/usr/bin/kitty'],
            ['x-terminal-emulator', '/usr/bin/x-terminal-emulator'],
            ['xterm', '/usr/bin/xterm'],
        ]);
        const plan = buildTerminalChain({
            dir: '/home/me/proj',
            host: linuxHost({ DISPLAY: ':0' }),
            resolve: (name) => present.get(name) ?? null,
        });
        expect(plan.specs.map((spec) => spec.label))
            .toEqual(['gnome-terminal', 'kitty', 'x-terminal-emulator', 'xterm']);
        expect(plan.specs[0]!.args).toEqual(['--working-directory=/home/me/proj']);
        // The generic fallbacks carry no flag — the child's cwd does the work.
        expect(plan.specs[2]!.args).toEqual([]);
        expect(plan.specs.every((spec) => spec.cwd === '/home/me/proj')).toBe(true);
        expect(plan.specs.every((spec) => spec.detached && !spec.windowsVerbatimArguments)).toBe(true);
    });

    it('adds a Windows-side Windows Terminal as a WSL last resort', () => {
        const host: LaunchHost = {
            platform: 'linux',
            env: { WSL_DISTRO_NAME: 'Ubuntu' },
            release: '5.15.90.1-microsoft-standard-WSL2',
        };
        const plan = buildTerminalChain({
            dir: '/home/me/proj',
            host,
            resolve: (name) => {
                if (name === 'xterm') return '/usr/bin/xterm';
                if (name === 'cmd.exe') return '/mnt/c/Windows/System32/cmd.exe';
                return null;
            },
        });
        expect(plan.specs.map((spec) => spec.label)).toEqual(['xterm', 'wt.exe (Windows side)']);
        expect(plan.specs[1]!.args[3]).toContain('\\\\wsl$\\Ubuntu\\home\\me\\proj');
    });

    it('translates a WSL folder into the \\\\wsl$ UNC form Windows accepts', () => {
        expect(wslUncPath('/home/me/proj', 'Ubuntu')).toBe('\\\\wsl$\\Ubuntu\\home\\me\\proj');
        expect(wslUncPath('/', 'Ubuntu')).toBe('\\\\wsl$\\Ubuntu\\');
    });
});

describe('platform gates', () => {
    it('detects WSL from env markers and from the kernel release', () => {
        expect(detectWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, '')).toBe(true);
        expect(detectWsl('linux', {}, '5.15.90.1-microsoft-standard-WSL2')).toBe(true);
        expect(detectWsl('linux', {}, '5.15.0-generic')).toBe(false);
        expect(detectWsl('win32', { WSL_DISTRO_NAME: 'Ubuntu' }, '')).toBe(false);
    });

    it('answers whether a graphical session is reachable', () => {
        expect(hasGraphicalSession('win32', {}, '')).toBe(true);
        expect(hasGraphicalSession('darwin', {}, '')).toBe(true);
        expect(hasGraphicalSession('linux', {}, '5.15.0-generic')).toBe(false);
        expect(hasGraphicalSession('linux', { DISPLAY: ':0' }, '')).toBe(true);
        expect(hasGraphicalSession('linux', { WAYLAND_DISPLAY: 'wayland-0' }, '')).toBe(true);
        // A WSL box without WSLg still reaches the Windows terminal.
        expect(hasGraphicalSession('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, '')).toBe(true);
    });

    it('always has a human-facing hint per platform', () => {
        expect(terminalHint('win32')).toContain('Windows Terminal');
        expect(terminalHint('darwin')).toContain('Terminal.app');
        expect(terminalHint('linux')).toContain('gnome-terminal');
    });

    it('quotes a token for the cmd command line', () => {
        expect(quoteForCmd('C:\\my dir\\wt.exe')).toBe('"C:\\my dir\\wt.exe"');
    });

    it('resolves the current host from the real platform', () => {
        expect(currentHost().platform).toBe(process.platform);
        expect(currentHost('linux').platform).toBe('linux');
    });
});
