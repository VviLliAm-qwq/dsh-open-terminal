import { describe, expect, it } from 'vitest';

import { STRING_KEYS, langFilePath, normalizeLang, resolveLang, t } from '../src/i18n.js';

describe('language resolution', () => {
    it('normalizes every shape the ecosystem produces', () => {
        expect(normalizeLang('zh')).toBe('zh');
        expect(normalizeLang(' zh-CN ')).toBe('zh');
        expect(normalizeLang('zh_CN.UTF-8')).toBe('zh');
        expect(normalizeLang('en')).toBe('en');
        expect(normalizeLang('en_GB@euro')).toBe('en');
        expect(normalizeLang('')).toBeUndefined();
        expect(normalizeLang('fr')).toBeUndefined();
        expect(normalizeLang(undefined)).toBeUndefined();
    });

    it('prefers the environment pin, then the live host setting, then the file', () => {
        const readLangFile = () => 'en' as const;
        expect(resolveLang({ env: { DSH_TUI_LANG: 'en' }, settingsLang: 'zh', readLangFile })).toBe('en');
        expect(resolveLang({ env: {}, settingsLang: 'zh', readLangFile })).toBe('zh');
        expect(resolveLang({ env: {}, readLangFile })).toBe('en');
    });

    it('an unsupported but present locale reads as English; a missing one keeps Chinese', () => {
        expect(resolveLang({ env: { LANG: 'fr_FR.UTF-8' }, readLangFile: () => undefined })).toBe('en');
        expect(resolveLang({ env: { LANG: 'zh_CN.UTF-8' }, readLangFile: () => undefined })).toBe('zh');
        // A Chinese host that never wrote a preference must be unchanged.
        expect(resolveLang({ env: {}, readLangFile: () => undefined })).toBe('zh');
    });

    it('a throwing file reader is contained', () => {
        const readLangFile = () => {
            throw new Error('boom');
        };
        expect(resolveLang({ env: {}, readLangFile })).toBe('zh');
    });

    it('the preference file follows the state directory, with an override', () => {
        expect(langFilePath({ DSH_TUI_STATE_DIR: '/tmp/state' }).replace(/\\/g, '/')).toBe('/tmp/state/lang.json');
        expect(langFilePath({ DSH_OPEN_TERMINAL_LANG_FILE: '/tmp/custom.json' })).toBe('/tmp/custom.json');
        expect(langFilePath({})).toMatch(/lang\.json$/);
    });
});

describe('strings', () => {
    it('both dictionaries define every key', () => {
        for (const key of STRING_KEYS) {
            expect(t('zh', key), `zh.${key}`).not.toBe(key);
            expect(t('en', key), `en.${key}`).not.toBe(key);
        }
    });

    it('substitutes placeholders and leaves an unknown one visible', () => {
        expect(t('zh', 'dirMissing', { dir: '/tmp/x' })).toBe('目录不存在：/tmp/x');
        expect(t('en', 'dirMissing', { dir: '/tmp/x' })).toBe('directory does not exist: /tmp/x');
        expect(t('en', 'opened', { dir: '/tmp/x', launcher: 'wt.exe' })).toBe('opened a terminal in /tmp/x (wt.exe)');
        expect(t('en', 'opened', {})).toBe('opened a terminal in {dir} ({launcher})');
    });

    it('an unknown key renders as the key itself, and an unknown language falls back to Chinese', () => {
        expect(t('zh', 'no-such-key')).toBe('no-such-key');
        expect(t('fr' as 'zh', 'noGraphicalSession')).toBe('当前环境没有图形会话，无法打开终端');
    });

    it('the launcher hints and the not-a-folder message differ per language', () => {
        expect(t('zh', 'hintWindows')).toContain('Windows Terminal');
        expect(t('en', 'hintWindows')).toContain('command');
        expect(t('zh', 'notAFolder', { target: 'x' })).toContain('只在文件夹打开终端');
        expect(t('en', 'notAFolder', { target: 'x' })).toContain('is a file, not a folder');
        expect(t('zh', 'listSeparator')).toBe('、');
        expect(t('en', 'listSeparator')).toBe(', ');
    });
});
