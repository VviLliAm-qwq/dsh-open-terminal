import { describe, expect, it, vi } from 'vitest';
import { Config, apply, name, type CommandDefinitionLike } from '../src/plugin.js';

// Same pin as in command.test.ts: the registered hint is asserted in Chinese,
// and `apply()` resolves the language through `resolveLang`, whose last resort
// is the OS locale — `C.UTF-8` on a CI runner, which lands on `en`.
process.env.DSH_TUI_LANG = 'zh';

/** A minimal Cordis-like context: `get` answers by exact service key only. */
function strictCtx(services: Record<string, unknown>): {
    ctx: unknown;
    effects: Array<{ cleanup: () => void; label?: string }>;
    warns: string[];
} {
    const effects: Array<{ cleanup: () => void; label?: string }> = [];
    const warns: string[] = [];
    return {
        ctx: {
            get: (key: string) => services[key],
            effect: (setup: () => () => void, label?: string) => {
                effects.push({ cleanup: setup(), label });
                return () => {};
            },
            logger: { info: () => {}, warn: (message: string) => { warns.push(message); } },
        },
        effects,
        warns,
    };
}

describe('plugin identity and configuration', () => {
    it('keeps the Cordis row id and the package name in sync', () => {
        expect(name).toBe('dsh-open-terminal');
    });

    it('resolves every configuration key to its documented default', () => {
        expect(Config({})).toMatchObject({
            command: '',
            maxDepth: 6,
            maxEntries: 20000,
            maxCandidates: 0,
            includeHidden: false,
        });
    });

    it('keeps explicit configuration values', () => {
        expect(Config({ command: 'wt.exe -d {dir}', maxCandidates: 5, maxDepth: 2, includeHidden: true }))
            .toMatchObject({ command: 'wt.exe -d {dir}', maxCandidates: 5, maxDepth: 2, includeHidden: true });
    });
});

describe('apply', () => {
    it('registers /term through the commands-service fallback', () => {
        const registered: CommandDefinitionLike[] = [];
        const { ctx } = strictCtx({
            commands: { register: (definition: CommandDefinitionLike) => { registered.push(definition); return () => {}; } },
        });
        apply(ctx as never, {});
        expect(registered.map((definition) => definition.name)).toEqual(['term']);
        expect(registered[0]!.description).toContain('terminal');
        expect(registered[0]!.input?.hint).toContain('工作目录');
    });

    it('prefers the mediated tuiPluginHost surface when the host offers it', () => {
        const mediated: CommandDefinitionLike[] = [];
        const direct: CommandDefinitionLike[] = [];
        const { ctx } = strictCtx({
            tuiPluginHost: {
                registerCommand: (_pluginCtx: unknown, definition: CommandDefinitionLike) => {
                    mediated.push(definition);
                    return () => {};
                },
            },
            commands: { register: (definition: CommandDefinitionLike) => { direct.push(definition); return () => {}; } },
        });
        apply(ctx as never, {});
        expect(mediated).toHaveLength(1);
        expect(direct).toHaveLength(0);
        expect(mediated[0]!.name).toBe('term');
    });

    it('never throws when a seam refuses the registration', () => {
        const { ctx, warns } = strictCtx({
            tuiPluginHost: { registerCommand: () => { throw new Error('requires a live Cordis activation context'); } },
        });
        expect(() => apply(ctx as never, {})).not.toThrow();
        expect(warns.join(' ')).toContain('registration failed');
    });

    it('degrades quietly when no command service exists', () => {
        const { ctx, warns } = strictCtx({});
        expect(() => apply(ctx as never, {})).not.toThrow();
        expect(warns.join(' ')).toContain('no command service available');
    });

    it('disposes the registration through ctx.effect', () => {
        const dispose = vi.fn();
        const { ctx, effects } = strictCtx({
            commands: { register: () => dispose },
        });
        apply(ctx as never, {});
        expect(effects).toHaveLength(1);
        expect(effects[0]!.label).toBe('dsh-open-terminal command');
        effects[0]!.cleanup();
        expect(dispose).toHaveBeenCalledTimes(1);
    });
});
