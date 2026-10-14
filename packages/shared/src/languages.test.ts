import { describe, expect, it } from 'vitest';
import {
  EN_CATALOGUE, LANGUAGES, PUBLIC_UI_KEYS, SCRIPTS, SECONDARY_CHOICES, UNTRANSLATED_KEYS, checkCatalogue, directionOf, effectiveLocale, findTranslationKeys,
  isLanguageCode, isSecondaryLanguageCode, languageInfo, placeholdersOf, scriptOf, secondaryLanguageProblem, translationProblem, uiLocaleProblem,
} from './index.js';

describe('language registry', () => {
  it('has about thirty languages, each complete and unique, English first', () => {
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(30);
    expect(LANGUAGES[0]!.code).toBe('en');
    expect(new Set(LANGUAGES.map((l) => l.code)).size).toBe(LANGUAGES.length);
    for (const l of LANGUAGES) {
      expect(l.nameEn.length).toBeGreaterThan(0);
      expect(l.nativeName.length).toBeGreaterThan(0);
      expect(['ltr', 'rtl']).toContain(l.dir);
      expect(SCRIPTS).toContain(l.script);
    }
  });

  it('marks the right-to-left languages and the scripts of the CJK ones', () => {
    for (const c of ['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'ku-Arab']) expect(directionOf(c)).toBe('rtl');
    for (const c of ['en', 'fr', 'zh-Hans', 'ja', 'ko', 'hi', 'ru']) expect(directionOf(c)).toBe('ltr');
    expect([scriptOf('zh-Hans'), scriptOf('zh-Hant'), scriptOf('ja'), scriptOf('ko')]).toEqual(['cjk-sc', 'cjk-tc', 'cjk-jp', 'cjk-kr']);
    expect(scriptOf('ar')).toBe('arabic');
    expect(directionOf('xx')).toBe('ltr');
    expect(languageInfo('ar')).toMatchObject({ nameEn: 'Arabic', nativeName: 'العربية' });
  });

  it('offers everything but English as a secondary language', () => {
    expect(SECONDARY_CHOICES.some((l) => l.code === 'en')).toBe(false);
    expect(isLanguageCode('ar')).toBe(true);
    expect(isSecondaryLanguageCode('en')).toBe(false);
    expect(isSecondaryLanguageCode('klingon')).toBe(false);
    expect(isSecondaryLanguageCode('ar')).toBe(true);
  });
});

describe('language rules', () => {
  it('the secondary language is in the registry, is not English, or is none', () => {
    expect(secondaryLanguageProblem(null)).toBeNull();
    expect(secondaryLanguageProblem('ar')).toBeNull();
    expect(secondaryLanguageProblem('en')).toMatch(/primary/);
    expect(secondaryLanguageProblem('xx')).toMatch(/not a language/);
  });

  it("a person's interface language is English or the institution's secondary language", () => {
    expect(uiLocaleProblem(null, null)).toBeNull();
    expect(uiLocaleProblem('en', null)).toBeNull();
    expect(uiLocaleProblem('ar', 'ar')).toBeNull();
    expect(uiLocaleProblem('ar', null)).toMatch(/must be English/);
    expect(uiLocaleProblem('fr', 'ar')).toMatch(/English or Arabic/);
  });

  it("the effective language is the person's own, else the institution's default, else English", () => {
    expect(effectiveLocale('ar', 'en', 'ar')).toBe('ar');
    expect(effectiveLocale(null, 'ar', 'ar')).toBe('ar');
    expect(effectiveLocale(null, 'en', 'ar')).toBe('en');
    expect(effectiveLocale('fr', 'ar', 'ar')).toBe('ar'); // a stale choice is ignored
    expect(effectiveLocale('ar', 'ar', null)).toBe('en'); // the language was switched off
  });
});

describe('placeholders and the translation check', () => {
  it('finds placeholders', () => {
    expect(placeholdersOf('My requests ({{count}}) and {{ name }} {{count}}')).toEqual(['count', 'name']);
    expect(placeholdersOf('none')).toEqual([]);
  });

  it('accepts a translation that keeps every placeholder exactly', () => {
    expect(translationProblem('My requests ({{count}})', 'طلباتي ({{count}})')).toBeNull();
    expect(translationProblem('{{a}} of {{b}}', '{{b}} من {{a}}')).toBeNull();
    expect(translationProblem('Save', 'حفظ')).toBeNull();
  });

  it('rejects a dropped, changed, translated, respaced or invented placeholder, an empty text and new HTML', () => {
    expect(translationProblem('{{count}} items', 'عناصر')).toMatch(/missing/);
    expect(translationProblem('{{count}} items', '{{عدد}} عناصر')).toMatch(/missing/);
    expect(translationProblem('{{count}} items', '{{ count }} عناصر')).toMatch(/exactly/);
    expect(translationProblem('{{count}} items', '{{count}} {{extra}} عناصر')).toMatch(/not in the English/);
    expect(translationProblem('Save', '   ')).toMatch(/empty/);
    expect(translationProblem('Save', '<b>حفظ</b>')).toMatch(/HTML/);
    expect(translationProblem('Press <b>Save</b>', 'اضغط <b>حفظ</b>')).toBeNull();
  });
});

describe('the English catalogue', () => {
  it('has placeholder-clean, HTML-free strings; the product name is the only untranslated one; sign-in keys exist', () => {
    for (const [k, v] of Object.entries(EN_CATALOGUE)) {
      expect(v.trim(), k).not.toBe('');
      expect(v, k).not.toMatch(/<\/?[a-z]/i);
      expect(v, k).not.toMatch(/\b(compliant|readiness score)\b/i);
    }
    expect(UNTRANSLATED_KEYS).toEqual(['appName']);
    for (const k of PUBLIC_UI_KEYS) expect(EN_CATALOGUE, k).toHaveProperty(k);
    expect(PUBLIC_UI_KEYS.every((k) => k.startsWith('login.') || k === 'language.menu')).toBe(true);
  });

  it('finds the keys used in code and reports what is missing', () => {
    const src = "const a = t('nav.settings'); const b = i18n.t(\"common.save\"); t(`login.title`); notT('x.y'); t(variable);";
    expect(findTranslationKeys(src).sort()).toEqual(['common.save', 'login.title', 'nav.settings']);
    const used = new Map([['nav.settings', ['a.tsx']], ['nope.key', ['b.tsx']]]);
    const r = checkCatalogue(used, EN_CATALOGUE, ['login.title', 'zzz']);
    expect(r.missing).toEqual([{ key: 'nope.key', files: ['b.tsx'] }]);
    expect(r.unused).not.toContain('nav.settings');
    expect(r.unused).toContain('login.title');
    expect(r.publicMissing).toEqual(['zzz']);
  });
});
