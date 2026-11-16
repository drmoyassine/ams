// Programs as a workbook (the owner, 2026-11-16): one template for export and import, as .xlsx (three sheets) or .csv (one file per sheet),
// and the same rows over the API. Rows are matched by Program code (and, for PEOs and PLOs, their code within the program): a match is
// updated, anything else is added, nothing absent from the file is removed. A row missing a required field is saved and flagged; only a
// row that cannot be placed (no code, name, unit or level) is skipped, with the reason.
import { z } from 'zod';

export const PROGRAM_SHEETS = {
  programs: { name: 'Programs', headers: ['Program code', 'Name (English)', 'Name (Arabic)', 'Unit', 'Program level', 'SIS code', 'Mode', 'Credits', 'Years', 'Contact hours', 'Language', 'Mission', 'Vision', 'Active'] },
  peos: { name: 'PEOs', headers: ['Program code', 'Code', 'Statement (English)', 'Statement (Arabic)'] },
  plos: { name: 'PLOs', headers: ['Program code', 'Code', 'Statement (English)', 'Statement (Arabic)', 'Bloom level'] },
} as const;
export type ProgramSheetKey = keyof typeof PROGRAM_SHEETS;

export type ProgramSheetRow = Record<string, string | number | null>;
export interface ProgramsWorkbook { programs: ProgramSheetRow[]; peos: ProgramSheetRow[]; plos: ProgramSheetRow[] }
const rows = z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).max(5000).default([]);
export const ProgramsWorkbookSchema: z.ZodType<ProgramsWorkbook, ProgramsWorkbook> = z.object({ programs: rows, peos: rows, plos: rows }).strict() as unknown as z.ZodType<ProgramsWorkbook, ProgramsWorkbook>;

/** The import (and the API's bulk upsert): with `apply` false nothing is written and the result says what would happen. */
export interface UpsertPrograms { workbook: ProgramsWorkbook; apply: boolean }
export const UpsertProgramsSchema: z.ZodType<UpsertPrograms, UpsertPrograms> = z.object({ workbook: ProgramsWorkbookSchema, apply: z.boolean() }).strict() as unknown as z.ZodType<UpsertPrograms, UpsertPrograms>;

export interface UpsertProgramsRow {
  sheet: 'Programs' | 'PEOs' | 'PLOs'; row: number; code: string;
  action: 'add' | 'update' | 'unchanged' | 'skip';
  /** Why a row is skipped, or what a saved program still lacks. */
  message: string;
}
export interface UpsertProgramsResult { applied: boolean; added: number; updated: number; unchanged: number; skipped: number; rows: UpsertProgramsRow[] }
export const UpsertProgramsResultSchema = z.any() as unknown as z.ZodType<UpsertProgramsResult, UpsertProgramsResult>;

/** Reads a cell by header, however the header is spelled or cased. */
export function sheetCell(r: ProgramSheetRow, header: string): string {
  const want = header.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [k, v] of Object.entries(r)) if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === want) return v === null || v === undefined ? '' : String(v).normalize('NFC').trim();
  return '';
}

/** Which sheet a CSV file is, from its headers (Mission: programs; Bloom level: PLOs; otherwise PEOs). */
export function sheetOfHeaders(headers: string[]): ProgramSheetKey | null {
  const h = new Set(headers.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (h.has('mission') || h.has('programlevel')) return 'programs';
  if (!h.has('programcode') || !h.has('statementenglish')) return null;
  return h.has('bloomlevel') ? 'plos' : 'peos';
}
