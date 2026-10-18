// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { MAX_CANVAS_AREA, MAX_CANVAS_SIDE, pngScale, serializeChartSvg } from './chart-export';
import { boxAt, boxModel, BOX_W, chartDrop, defaultChildType, isRtlText, lockedReason } from './chart-model';

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

describe('editing on the chart', () => {
  const units = [
    { id: 'a', parentId: null, displayOrder: 0, nameEn: 'Arts' },
    { id: 'a1', parentId: 'a', displayOrder: 0, nameEn: 'Dept1' },
    { id: 's', parentId: null, displayOrder: 1, nameEn: 'Science' },
  ];
  it('finds the box under a point', () => {
    const boxes = [{ id: 'a', x: 0, y: 0, w: 100, h: 50 }, { id: 's', x: 200, y: 0, w: 100, h: 50 }];
    expect(boxAt(boxes, 10, 10)).toBe('a');
    expect(boxAt(boxes, 250, 49)).toBe('s');
    expect(boxAt(boxes, 150, 10)).toBeNull();
  });
  it('puts a dropped unit last under the box, and refuses itself or its own sub-units in words', () => {
    expect(chartDrop(units, 's', 'a')).toEqual({ ok: true, text: 'Put Science under Arts.', moves: [{ id: 's', parentId: 'a', index: 1 }], noop: false });
    expect(chartDrop(units, 'a', 'a1')).toMatchObject({ ok: false, text: 'Cannot drop here. A unit cannot be moved under itself or one of its own sub-items.' });
    expect(chartDrop(units, 'a', 'a')).toMatchObject({ ok: false, text: 'Cannot drop here. Arts cannot be moved under itself.' });
    expect(chartDrop(units, 'a1', 'a')).toMatchObject({ ok: true, noop: true, text: 'Dept1 is already under Arts.' });
  });
  it('says why a locked unit is not moved, and starts a sub-unit with its parent\'s type', () => {
    expect(lockedReason({ nameEn: 'Arts', locked: true })).toMatch(/^Arts is locked/);
    expect(lockedReason({ nameEn: 'Arts', locked: false })).toBeNull();
    const types = [{ key: 'college' }, { key: 'department' }];
    expect(defaultChildType('department', types)).toBe('department');
    expect(defaultChildType('gone', types)).toBe('college');
    expect(defaultChildType(null, [])).toBe('');
  });
});
