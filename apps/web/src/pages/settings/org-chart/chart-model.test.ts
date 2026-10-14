// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MAX_CANVAS_AREA, MAX_CANVAS_SIDE, pngScale, serializeChartSvg } from './chart-export';
import { boxModel, BOX_W, isRtlText } from './chart-model';

describe('boxModel', () => {
  it('wraps long names, puts the Arabic name beneath, and grows the box with its text', () => {
    const short = boxModel({ nameEn: 'Law', nameAr: null, headUserName: null, headName: null }, 'College');
    const long = boxModel({ nameEn: 'College of Engineering, Petroleum and Applied Sciences', nameAr: 'كلية الهندسة والبترول والعلوم التطبيقية', headUserName: 'Dr Head', headName: null }, 'College');
    expect(short).toMatchObject({ en: ['Law'], ar: [], head: null, w: BOX_W, h: 72 });
    expect(long.en.length).toBeGreaterThan(1);
    expect(long.en.length).toBeLessThanOrEqual(3);
    expect(long.ar.length).toBeGreaterThan(0);
    expect(long.head).toBe('Dr Head');
    expect(long.h).toBeGreaterThan(short.h);
    expect(long.y.ar).toBeGreaterThan(long.y.en);
    expect(long.y.head).toBeGreaterThan(long.y.ar);
  });
  it('prefers the person over a typed name for the head', () => {
    expect(boxModel({ nameEn: 'X', nameAr: null, headUserName: 'Ann', headName: null }, 't').head).toBe('Ann');
    expect(boxModel({ nameEn: 'X', nameAr: null, headUserName: null, headName: 'Dr Y' }, 't').head).toBe('Dr Y');
  });
});

describe('isRtlText', () => {
  it('goes by the first letter', () => {
    expect(isRtlText('كلية')).toBe(true);
    expect(isRtlText('1. كلية')).toBe(true);
    expect(isRtlText('College كلية')).toBe(false);
    expect(isRtlText('')).toBe(false);
  });
});

describe('pngScale', () => {
  it('is 2x for an ordinary chart and less for one too big for a canvas', () => {
    expect(pngScale(1200, 800)).toBe(2);
    const big = pngScale(30000, 3000);
    expect(big).toBeLessThan(1);
    expect(30000 * big).toBeLessThanOrEqual(MAX_CANVAS_SIDE + 1);
    const wide = pngScale(9000, 9000);
    expect(9000 * 9000 * wide * wide).toBeLessThanOrEqual(MAX_CANVAS_AREA + 1);
  });
});

describe('serializeChartSvg', () => {
  it('makes a standalone document of the whole chart: viewBox, size, background, no zoom transform, no skipped nodes', () => {
    document.body.innerHTML = `<svg class="x" style="width:10px" tabindex="0"><g data-view="" transform="translate(5 5) scale(2)"><text direction="rtl">كلية</text><g data-export-skip=""><circle/></g></g></svg>`;
    const out = serializeChartSvg(document.querySelector('svg')!, { width: 640, height: 360 }, { fontCss: '@font-face{font-family:X}', title: 'Org chart' });
    expect(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(out).toContain('viewBox="0 0 640 360"');
    expect(out).toContain('width="640"');
    expect(out).toContain('<rect width="640" height="360" fill="#ffffff"/>');
    expect(out).toContain('<style>@font-face{font-family:X}</style>');
    expect(out).toContain('<title>Org chart</title>');
    expect(out).toContain('كلية');
    expect(out).not.toContain('transform=');
    expect(out).not.toContain('circle');
    expect(out).not.toContain('tabindex');
    // The live chart is untouched.
    expect(document.querySelector('[data-view]')!.getAttribute('transform')).toBe('translate(5 5) scale(2)');
  });
});
