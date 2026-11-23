// Programs as a workbook (the owner, 2026-11-16): one template for export and import, as .xlsx (three sheets) or .csv (one file per sheet),
// and the same rows over the API. Rows are matched by Program code (and, for PEOs and PLOs, their code within the program): a match is
// updated, anything else is added, nothing absent from the file is removed. A row missing a required field is saved and flagged; only a
// row that cannot be placed (no code, name, unit or level) is skipped, with the reason.
import { z } from 'zod';

/**
 * The sheets, their columns and which are required. `ID` is the record's own id (filled in by an export, empty for a new row): with it a row
 * updates that record even when its code changes. `Program name` on the PEOs and PLOs sheets only shows which program a code is (a lookup
 * in the workbook); the import ignores it.
 */
export const PROGRAM_SHEETS = {
  programs: {
    name: 'Programs',
    headers: ['ID', 'Program code', 'Name (English)', 'Name (Arabic)', 'Unit', 'Program level', 'Type', 'SIS code', 'Mode', 'Credits', 'GenEd credits', 'Free elective credits', 'Years', 'Contact hours', 'Language', 'Mission', 'Vision', 'Active'],
    required: ['Program code', 'Name (English)', 'Name (Arabic)', 'Unit', 'Program level', 'Mode', 'Credits', 'Years', 'Contact hours', 'Language', 'Mission'],
  },
  peos: { name: 'PEOs', headers: ['ID', 'Program code', 'Program name', 'Code', 'Statement (English)', 'Statement (Arabic)', 'Status'], required: ['Program code', 'Code', 'Statement (English)'] },
  plos: { name: 'PLOs', headers: ['ID', 'Program code', 'Program name', 'Code', 'Statement (English)', 'Statement (Arabic)', 'Bloom level', 'ILOs', 'Status'], required: ['Program code', 'Code', 'Statement (English)'] },
} as const;
/** Words of the dropdowns (the import also takes the codes behind them). */
export const PROGRAM_LEVEL_WORDS = ['Associate', 'Bachelor', 'Master', 'Doctorate', 'Diploma', 'Certificate'] as const;
export const PROGRAM_TYPE_WORDS = ['Degree', 'Minor'] as const;
export const PROGRAM_MODE_WORDS = ['On-campus', 'Online', 'Blended'] as const;
export const OUTCOME_STATUS_WORDS = ['Draft', 'Approved', 'Retired'] as const;
export const BLOOM_WORDS = ['Remember', 'Understand', 'Apply', 'Analyze', 'Evaluate', 'Create'] as const;
export type ProgramSheetKey = keyof typeof PROGRAM_SHEETS;

export type ProgramSheetRow = Record<string, string | number | null>;
export interface ProgramsWorkbook { programs: ProgramSheetRow[]; peos: ProgramSheetRow[]; plos: ProgramSheetRow[] }
/** An export: the rows, and the institution's choices for the dropdowns (its units as org-chart paths, its languages). */
export interface ProgramsExport extends ProgramsWorkbook { lists: { units: string[]; languages: string[]; /** The institution's ILO codes, for the PLOs' ILOs column. */ ilos: string[] } }
export const ProgramsExportSchema = z.any() as unknown as z.ZodType<ProgramsExport, ProgramsExport>;
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
