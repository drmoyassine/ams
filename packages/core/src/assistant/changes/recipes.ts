// The recipes: deterministic rules that turn ONE row into its new values. The model chooses the recipe and its parameters; this
// code computes every row, so the examples in the confirmation are exact and a run is reproducible. Pure functions: no
// database, no model. Text results are NFC, never get direction marks added (the screens render with dir="auto"), and are
// compared with what is there so a row the rule would not change is not counted.
import type { z } from 'zod';
import type { CopyFieldOp, PrefixOrReplaceTextOp, RecodeOp } from '@ams/shared';
import { MAX_WORDING_TITLE, placeWording } from '../../framework/exchange.js';
import type { ReqRow } from './filter.js';
import { compileRegex, MAX_SUBJECT_CHARS } from './regex.js';
import type { ReqPatch } from './types.js';

/** What a rule says about one row: a patch, nothing to do, or a reason it is left alone. */
export type RowResult = { patch: ReqPatch } | { skip: string } | null;

const nfc = (s: string) => s.normalize('NFC');
const compact = (v: string) => v.replace(/\s+/g, '').toLowerCase();
const blank = (s: string | null | undefined) => !s || !s.trim();
const oneLine = (s: string) => nfc(s).replace(/\s+/g, ' ').trim();

/** Keeps only the fields that really differ from the row. */
export function changed(row: ReqRow, patch: ReqPatch): ReqPatch | null {
  const out: ReqPatch = {};
  const cur: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined && cur[k] !== v) (out as Record<string, unknown>)[k] = v;
  return Object.keys(out).length ? out : null;
}
const result = (row: ReqRow, patch: ReqPatch): RowResult => { const p = changed(row, patch); return p ? { patch: p } : null; };

// ---- swap_title_and_description ------------------------------------------------------------------------------------------
/**
 * statement_to_title: an item whose title is only its code gets its statement (the description) as the title. This is the
 * importer's own rule, `placeWording` (also migration 0047): the same function decides. title_to_statement is its reverse: the
 * title becomes the description (when there is none) and the title is the code again.
 */
export function swapTitleAndDescription(row: ReqRow, direction: 'statement_to_title' | 'title_to_statement'): RowResult {
  const titleIsCode = compact(row.title) === compact(row.code);
  if (direction === 'statement_to_title') {
    if (!titleIsCode) return null;
    if (blank(row.officialText)) return { skip: 'the title is only the code and there is no description to use' };
    const w = placeWording(row.code, row.title, row.officialText);
    if (w.title === row.title) {
      return { skip: compact(row.officialText ?? '') === compact(row.code) ? 'its description is only the code too' : `the statement is longer than ${MAX_WORDING_TITLE} characters, so it stays the description` };
    }
    return result(row, { title: nfc(w.title), officialText: w.officialText });
  }
  if (titleIsCode) return null;
  if (!blank(row.officialText)) return { skip: 'it already has a description' };
  return result(row, { officialText: nfc(row.title.trim()), title: row.code });
}

// ---- copy_field -------------------------------------------------------------------------------------------------------------
export function copyField(row: ReqRow, op: z.infer<typeof CopyFieldOp>): RowResult {
  const from = op.from === 'code' ? row.code : op.from === 'title' ? row.title : op.from === 'officialText' ? row.officialText : row.translationEn;
  if (blank(from)) return { skip: `its ${fieldWords(op.from)} is empty` };
  const target = op.to === 'title' ? row.title : op.to === 'officialText' ? row.officialText : row.translationEn;
  if (op.onlyIfEmpty && !blank(target)) return { skip: `its ${fieldWords(op.to)} already has text` };
  const value = op.to === 'title' ? oneLine(from!) : nfc(from!.trim());
  if (op.to === 'title' && !value) return null;
  return result(row, { [op.to]: value } as ReqPatch);
}
export const fieldWords = (f: string) => (f === 'officialText' ? 'description' : f === 'translationEn' ? 'English translation' : f === 'levelLabel' ? 'level name' : f === 'isAssessable' ? 'assessable setting' : f);

// ---- prefix_or_replace_text ---------------------------------------------------------------------------------------------------
export interface TextRule { ok: true; run(row: ReqRow): RowResult }
export function textRule(op: z.infer<typeof PrefixOrReplaceTextOp>): TextRule | { ok: false; message: string } {
  let re: RegExp | null = null;
  if (op.mode === 'replace') {
    if (op.find === undefined) return { ok: false, message: 'a replace needs something to find' };
    if (op.regex) {
      const c = compileRegex(op.find, `u${op.caseInsensitive ? 'i' : ''}`);
      if (!c.ok) return { ok: false, message: c.message };
      re = new RegExp(c.re.source, `${c.re.flags}g`);
    }
  } else if (!op.text) return { ok: false, message: `a ${op.mode} needs the text to add` };
  const literal = op.find !== undefined && !op.regex ? nfc(op.find) : null;
  return {
    ok: true,
    run(row) {
      const cur = op.field === 'title' ? row.title : op.field === 'officialText' ? row.officialText : row.translationEn;
      if (blank(cur)) return op.mode === 'replace' ? null : { skip: `its ${fieldWords(op.field)} is empty` };
      const value = nfc(cur!);
      if (value.length > MAX_SUBJECT_CHARS) return { skip: 'the text is too long to change by a rule' };
      let next = value;
      if (op.mode === 'prefix') next = value.startsWith(nfc(op.text!)) ? value : `${nfc(op.text!)}${value}`;
      else if (op.mode === 'suffix') next = value.endsWith(nfc(op.text!)) ? value : `${value}${nfc(op.text!)}`;
      else if (re) next = value.replace(re, nfc(op.replaceWith ?? ''));
      else if (literal !== null) {
        next = op.caseInsensitive
          ? value.replace(new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), () => nfc(op.replaceWith ?? ''))
          : value.split(literal).join(nfc(op.replaceWith ?? ''));
      }
      if (next === value) return null;
      if (op.field === 'title' && !next.trim()) return { skip: 'the title would be left empty' };
      return result(row, { [op.field]: next } as ReqPatch);
    },
  };
}

// ---- recode ---------------------------------------------------------------------------------------------------------------------
export interface CodeRule { ok: true; newCode(row: ReqRow): string | null }
export function codeRule(op: z.infer<typeof RecodeOp>): CodeRule | { ok: false; message: string } {
  if (!op.mapping && !op.pattern) return { ok: false, message: 'recode needs a mapping or a pattern' };
  if (op.mapping && op.pattern) return { ok: false, message: 'give a mapping or a pattern, not both' };
  if (op.mapping) {
    const map = new Map<string, string>();
    for (const m of op.mapping) {
      const key = nfc(m.from).trim();
      if (map.has(key) && map.get(key) !== nfc(m.to).trim()) return { ok: false, message: `the code ${m.from} is mapped to two different codes` };
      map.set(key, nfc(m.to).trim());
    }
    return { ok: true, newCode: (row) => map.get(nfc(row.code).trim()) ?? null };
  }
  const p = op.pattern!;
  if (p.regex) {
    const c = compileRegex(p.find, 'u');
    if (!c.ok) return { ok: false, message: c.message };
    const re = new RegExp(c.re.source, 'gu');
    return { ok: true, newCode: (row) => { const v = nfc(row.code).replace(re, nfc(p.replaceWith)); return v === nfc(row.code) ? null : v.trim(); } };
  }
  const find = nfc(p.find);
  return { ok: true, newCode: (row) => { const v = nfc(row.code).split(find).join(nfc(p.replaceWith)); return v === nfc(row.code) ? null : v.trim(); } };
}

// ---- Plain fixed-value edits ------------------------------------------------------------------------------------------------------
export function setValues(row: ReqRow, set: { title?: string; officialText?: string | null; levelLabel?: string; isAssessable?: boolean; language?: string }): RowResult {
  const patch: ReqPatch = {};
  if (set.title !== undefined) patch.title = oneLine(set.title);
  if (set.officialText !== undefined) patch.officialText = set.officialText === null || !set.officialText.trim() ? null : nfc(set.officialText);
  if (set.levelLabel !== undefined) patch.levelLabel = oneLine(set.levelLabel);
  if (set.isAssessable !== undefined) patch.isAssessable = set.isAssessable;
  if (set.language !== undefined) patch.language = set.language.trim().toLowerCase();
  return result(row, patch);
}

/** Converts a set_field_by_filter value to a patch value, with a reason when the value does not fit the field. */
export function fieldValue(field: string, value: string | boolean | null): { ok: true; set: { title?: string; officialText?: string | null; levelLabel?: string; isAssessable?: boolean; language?: string } } | { ok: false; message: string } {
  if (field === 'isAssessable') return typeof value === 'boolean' ? { ok: true, set: { isAssessable: value } } : { ok: false, message: 'isAssessable takes true or false' };
  if (field === 'officialText') return value === null || typeof value === 'string' ? { ok: true, set: { officialText: value } } : { ok: false, message: 'the description takes text (or null to clear it)' };
  if (typeof value !== 'string' || !value.trim()) return { ok: false, message: `${fieldWords(field)} needs a value` };
  return { ok: true, set: { [field]: value } as { title?: string; levelLabel?: string; language?: string } };
}
