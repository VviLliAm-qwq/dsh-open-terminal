import { describe, expect, it } from 'vitest';
import { rankFolders, scoreMatch } from '../src/fuzzy.js';

const folder = (relPath: string) => ({
    relPath,
    absPath: `/ws/${relPath}`,
    isDir: true,
    basename: relPath.split('/').pop() as string,
});

describe('scoreMatch', () => {
    it('scores prefix > word boundary > substring > subsequence', () => {
        const prefix = scoreMatch('doc', 'docs');
        const word = scoreMatch('doc', 'my-docs');
        const substring = scoreMatch('oc', 'docs');
        const subsequence = scoreMatch('ds', 'docs');
        expect([prefix?.kind, word?.kind, substring?.kind, subsequence?.kind])
            .toEqual(['prefix', 'word', 'substring', 'subsequence']);
        expect(prefix!.score).toBeGreaterThan(word!.score);
        expect(word!.score).toBeGreaterThan(substring!.score);
        expect(substring!.score).toBeGreaterThan(subsequence!.score);
    });

    it('is case-insensitive and NFC-normalises both sides', () => {
        expect(scoreMatch('DOCS', 'docs')?.kind).toBe('prefix');
        // macOS hands back NFD file names while a keyboard produces NFC.
        expect(scoreMatch('café', 'cafe\u0301')).not.toBeNull();
    });

    it('matches CJK folder names', () => {
        expect(scoreMatch('文档', '文档中心')?.kind).toBe('prefix');
        expect(scoreMatch('文档', '项目文档')?.kind).toBe('substring');
    });

    it('returns null when nothing matches', () => {
        expect(scoreMatch('zz', 'docs')).toBeNull();
        expect(scoreMatch('', 'docs')).toBeNull();
        expect(scoreMatch('docs', '')).toBeNull();
        expect(scoreMatch('longer-than-target', 'short')).toBeNull();
    });
});

describe('rankFolders', () => {
    it('prefers a basename hit over a path-only hit', () => {
        const ranked = rankFolders('term', [folder('src/terminal-kit'), folder('terminal')], 0);
        expect(ranked.map((entry) => entry.relPath)).toEqual(['terminal', 'src/terminal-kit']);
    });

    it('keeps every match when the limit is <= 0 (unlimited)', () => {
        const ranked = rankFolders('a', [folder('alpha'), folder('beta'), folder('gamma')], 0);
        expect(ranked.map((entry) => entry.relPath).sort()).toEqual(['alpha', 'beta', 'gamma']);
        expect(rankFolders('a', [folder('alpha'), folder('beta'), folder('gamma')], -5)).toHaveLength(3);
    });

    it('honours a positive limit', () => {
        const ranked = rankFolders('a', [folder('alpha'), folder('beta'), folder('gamma')], 2);
        expect(ranked).toHaveLength(2);
        expect(ranked[0]!.relPath).toBe('alpha');
    });

    it('breaks score ties towards the shallower folder', () => {
        const ranked = rankFolders('thing', [folder('deep/nested/thing'), folder('thing')], 0);
        expect(ranked.map((entry) => entry.relPath)).toEqual(['thing', 'deep/nested/thing']);
    });

    it('returns nothing for an empty query or an empty index', () => {
        expect(rankFolders('', [folder('docs')], 0)).toEqual([]);
        expect(rankFolders('docs', [], 0)).toEqual([]);
    });
});
