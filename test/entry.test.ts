import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The entry's export shape is load-bearing, not cosmetic.
 *
 * A Cordis entry that re-exports its internals (helpers, constants, extra
 * functions) is wrapped differently by the loader, and the dsh-tui seam
 * services then reject every registration from that activation with
 * `requires a live Cordis activation context`: the plugin looks half-alive
 * while nothing appears in the UI. Shipping a shell that exports exactly the
 * three contract symbols is what keeps the activation admissible
 * (SOP §2.1). Regression reproduced 2026-09-10 on a headless profile.
 */
describe('entry shell', () => {
    it('exports exactly the contract symbols', async () => {
        const entry = await import('../src/index.js');
        expect(Object.keys(entry).sort()).toEqual(['Config', 'apply', 'name']);
        expect(entry.name).toBe('dsh-open-terminal');
        expect(typeof entry.apply).toBe('function');
        expect(typeof entry.Config).toBe('function');
    });

    it('has no default export', async () => {
        const entry = await import('../src/index.js');
        expect('default' in entry).toBe(false);
    });

    it('re-exports the implementation rather than duplicating it', async () => {
        const entry = await import('../src/index.js');
        const implementation = await import('../src/plugin.js');
        expect(entry.apply).toBe(implementation.apply);
        expect(entry.Config).toBe(implementation.Config);
        expect(entry.name).toBe(implementation.name);
    });

    it('stays a shell: one re-export line, no logic', () => {
        const shell = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
        expect(shell).toMatch(/export \{ Config, apply, name \} from '\.\/plugin\.js';/u);
        expect(shell).not.toMatch(/^export (const|function) (?!Config|apply|name)/mu);
        expect(shell).not.toMatch(/\bapply\(/u);
    });

    it('keeps the manifest entry pointing at the shell', () => {
        const manifest = JSON.parse(readFileSync(new URL('../dsh-plugin.json', import.meta.url), 'utf8'));
        expect(manifest.facets.host.entry).toBe('lib/index.js');
    });
});
