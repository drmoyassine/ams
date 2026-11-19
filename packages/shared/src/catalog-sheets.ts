// The catalog's structure as sheets of the academic workbook (DEC-045, DEC-046): Concentrations, Requirement blocks, Elective slots, GenEd areas
// and Catalog settings. Rows are matched by ID, else by their codes; an empty cell leaves a field as it is; nothing absent is removed.
export const CATALOG_SHEETS = {
  concentrations: {
    name: 'Concentrations',
    headers: ['ID', 'Program code', 'Program name', 'Code', 'Name (English)', 'Name (Arabic)', 'Active'] as readonly string[],
    required: ['Program code', 'Code', 'Name (English)'] as readonly string[],
  },
  blocks: {
    name: 'Requirement blocks',
    headers: ['Program code', 'Program name', 'Concentration', 'Block', 'Core credits', 'Elective credits'] as readonly string[],
    required: ['Program code', 'Block'] as readonly string[],
  },
  slots: {
    name: 'Elective slots',
    headers: ['ID', 'Program code', 'Program name', 'Concentration', 'Block', 'Slot name', 'Rule', 'Area', 'Credits', 'Year', 'Term'] as readonly string[],
    required: ['Program code', 'Block', 'Slot name', 'Credits'] as readonly string[],
  },
  genedAreas: {
    name: 'GenEd areas',
    headers: ['ID', 'Code', 'Name (English)', 'Name (Arabic)', 'Minimum credits', 'Courses'] as readonly string[],
    required: ['Code', 'Name (English)'] as readonly string[],
  },
  catalog: { name: 'Catalog settings', headers: ['Setting', 'Value'] as readonly string[], required: ['Setting', 'Value'] as readonly string[] },
} as const;
export type CatalogSheetKey = keyof typeof CATALOG_SHEETS;
export const CATALOG_SHEET_KEYS = Object.keys(CATALOG_SHEETS) as CatalogSheetKey[];
/** The one setting: the credits of General Education. */
export const GENED_CREDITS_SETTING = 'General education credits';

/** Which sheet a CSV file is, from its headers. */
export function catalogSheetOfHeaders(headers: string[]): CatalogSheetKey | null {
  const h = new Set(headers.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (h.has('setting') && h.has('value')) return 'catalog';
  if (h.has('slotname')) return 'slots';
  if (h.has('corecredits') || h.has('electivecredits')) return 'blocks';
  if (h.has('minimumcredits')) return 'genedAreas';
  if (h.has('programcode') && h.has('code') && h.has('nameenglish') && !h.has('mission')) return 'concentrations';
  return null;
}
