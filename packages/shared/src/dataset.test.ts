import { describe, expect, it } from 'vitest';
import { keyFromLabel, parseCell, validateRows, type DataColumn } from './dataset.js';

const col = (type: DataColumn['type'], extra: Partial<DataColumn> = {}): DataColumn => ({ key: 'k', label: 'K', type, required: false, ...extra });

describe('cells', () => {
  it('reads numbers with separators and Arabic digits', () => {
    expect(parseCell(col('number'), '1,234.5')).toEqual({ value: 1234.5 });
    expect(parseCell(col('number'), '١٢٣٫٥')).toEqual({ value: 123.5 });
    expect(parseCell(col('number'), 'abc').error).toBe('enter a number');
    expect(parseCell(col('integer'), '2.5').error).toBe('enter a whole number');
    expect(parseCell(col('integer'), 42)).toEqual({ value: 42 });
  });
  it('reads percents as the number shown', () => {
    expect(parseCell(col('percent'), '45%')).toEqual({ value: 45 });
    expect(parseCell(col('percent'), '45.5')).toEqual({ value: 45.5 });
  });
  it('reads dates and refuses impossible ones', () => {
    expect(parseCell(col('date'), '2025-09-01')).toEqual({ value: '2025-09-01' });
    expect(parseCell(col('date'), '1/9/2025')).toEqual({ value: '2025-09-01' });
    expect(parseCell(col('date'), '2025-02-30').error).toBeTruthy();
  });
  it('reads choices, yes/no, required and Arabic text', () => {
    expect(parseCell(col('choice', { choices: ['Male', 'Female'] }), 'female')).toEqual({ value: 'Female' });
    expect(parseCell(col('choice', { choices: ['Male', 'Female'] }), 'x').error).toMatch(/choose one of/);
    expect(parseCell(col('yes_no'), 'نعم')).toEqual({ value: true });
    expect(parseCell(col('text', { required: true, label: 'Program' }), ' ').error).toBe('Program is required');
    expect(parseCell(col('text'), 'هندسة')).toEqual({ value: 'هندسة' });
  });
  it('validates rows, skipping empty ones and naming each bad cell', () => {
    const cols = [col('text', { key: 'p', label: 'Program', required: true }), col('integer', { key: 'n', label: 'Headcount' })];
    const { rows, issues } = validateRows(cols, [{ p: 'BSME', n: '120' }, { p: '', n: '' }, { p: '', n: 'many' }]);
    expect(rows).toEqual([{ p: 'BSME', n: 120 }, { p: null, n: 'many' }]);
    expect(issues).toEqual([{ row: 1, key: 'p', message: 'Program is required' }, { row: 1, key: 'n', message: 'enter a number' }]);
  });
  it('makes keys from labels', () => {
    expect(keyFromLabel('Fall headcount (FTE)', [], 1)).toBe('fall_headcount_fte');
    expect(keyFromLabel('عدد الطلاب', [], 3)).toBe('col_3');
    expect(keyFromLabel('Year', ['year'], 2)).toBe('year_2');
  });
});
