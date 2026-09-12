/**
 * Fuzzy match scoring for dsh-open-terminal.
 *
 * Pure functions only (no fs/io) so the ranking rules are unit-testable:
 *   prefix > word boundary > substring > subsequence.
 * The basename of a candidate is weighted above its relative path, because
 * users usually remember the folder name, not the directory chain.
 *
 * Provenance: this ranker is the same rule set shipped by the sibling plugin
 * `dsh-open-path` (`/open`), kept identical on purpose — both commands answer
 * "which of my folders did I mean?", and a different feel between `/open` and
 * `/term` would be a bug in the ecosystem, not a feature. It stays a private
 * copy rather than a cross-plugin import: dsh-TUI plugins are independent
 * bundles that must not depend on each other's internals.
 *
 * @module dsh-open-terminal/fuzzy
 */

/** How a query matched a candidate string. */
export type MatchKind = 'prefix' | 'word' | 'substring' | 'subsequence';

/** One successful match: the quality kind and a comparable score (higher wins). */
export interface MatchResult {
    readonly kind: MatchKind;
    readonly score: number;
}

const WORD_SEPARATOR = /[^a-z0-9\u4e00-\u9fff]/u;

/**
 * Unicode-normalise a string for matching (NFC).
 *
 * Required for macOS: APFS/HFS+ hand back file names in NFD (decomposed), while
 * a user typing on the same machine produces NFC (composed) — so `café` typed
 * and `cafe\u0301` on disk would be different strings for `startsWith`/
 * `indexOf` and never match. Normalising both sides costs nothing on
 * Linux/Windows (already NFC) and makes the two forms interchangeable.
 */
function normalize(value: string): string {
    return value.normalize('NFC');
}

function toLower(value: string): string {
    return normalize(value).toLowerCase();
}

/**
 * Build a subsequence map: for every character index in `target`, the next
 * index of each query character (classic O(n·m) dynamic match, simplified for
 * short queries). Returns the number of gaps, or null when `query` is not a
 * subsequence of `target`.
 */
function subsequenceGaps(query: string, target: string): number | null {
    let cursor = 0;
    let gaps = 0;
    for (let index = 0; index < target.length; index += 1) {
        if (target[index] === query[cursor]) {
            cursor += 1;
            if (cursor === query.length) {
                // Gaps are the skipped characters before the LAST matched char.
                return gaps;
            }
        }
        else {
            if (cursor > 0) {
                // Only count characters skipped between matched ones.
                // (Characters before the first match do not matter.)
                gaps += 1;
            }
        }
    }
    return null;
}

/**
 * Score how well `query` matches `target` (both lowercased by the caller).
 * Returns null when the query does not match at all.
 *
 * Score bands (higher = better):
 *  - prefix:      1000 + query length bonus
 *  - word:        900  − position·5 − (target.length − query.length)·2
 *  - substring:   800  − position·10 − (target.length − query.length)·4
 *  - subsequence: 600  − gaps·6 − (target.length − query.length)·3
 */
export function scoreMatch(query: string, target: string): MatchResult | null {
    if (query === '' || target === '') return null;
    const q = toLower(query);
    const t = toLower(target);
    if (q.length > t.length) return null;

    // 1) Prefix: strongest signal.
    if (t.startsWith(q)) {
        return { kind: 'prefix', score: 1000 + q.length * 10 + (t.length - q.length) * -1 };
    }

    // 2) Word boundary: query starts where a word does.
    for (let index = 1; index < t.length - q.length + 1; index += 1) {
        if (t.startsWith(q, index) && WORD_SEPARATOR.test(t[index - 1] ?? '')) {
            return { kind: 'word', score: 900 - index * 5 - (t.length - q.length) * 2 };
        }
    }

    // 3) Substring anywhere.
    const sub = t.indexOf(q);
    if (sub >= 0) {
        return { kind: 'substring', score: 800 - sub * 10 - (t.length - q.length) * 4 };
    }

    // 4) Subsequence: all chars of q appear in t, in order.
    const gaps = subsequenceGaps(q, t);
    if (gaps !== null) {
        return { kind: 'subsequence', score: 600 - gaps * 6 - (t.length - q.length) * 3 };
    }

    return null;
}

/**
 * A scanned folder plus its fuzzy score resolution.
 * The fields mirror `scan.ts`'s `ScannedFolder`.
 */
export interface RankedFolder {
    readonly relPath: string;
    readonly absPath: string;
    readonly isDir: boolean;
    readonly score: number;
    readonly basename: string;
}

/**
 * Rank folders against a query. Candidates whose basename matches are
 * preferred over candidates matched only through a deep relative path; ties go
 * to the shorter path (less nested = what the user most likely meant).
 *
 * @param entries - scanned folders (any order)
 * @param limit - maximum number of results to return; `<= 0` means "no cap"
 *   and keeps every match (the managed dialog scrolls, so a broad query must
 *   not silently hide the folder the user meant)
 */
export function rankFolders<T extends { relPath: string; basename: string; isDir: boolean }>(
    query: string,
    entries: readonly T[],
    limit: number,
): Array<T & { score: number }> {
    if (query === '' || entries.length === 0) return [];
    const scored: Array<T & { score: number }> = [];
    for (const entry of entries) {
        const basename = scoreMatch(query, entry.basename);
        const path = scoreMatch(query, entry.relPath);
        if (basename === null && path === null) continue;
        // Basename wins: +120 base plus a prefix bonus.
        const best = basename !== null && (path === null || basename.score >= path.score)
            ? { ...basename, score: basename.score + 120 + (basename.kind === 'prefix' ? 80 : 0) }
            : path!;
        scored.push({ ...entry, score: best.score });
    }
    scored.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (left.relPath.length !== right.relPath.length) return left.relPath.length - right.relPath.length;
        return left.relPath < right.relPath ? -1 : left.relPath > right.relPath ? 1 : 0;
    });
    return limit > 0 ? scored.slice(0, limit) : scored;
}
