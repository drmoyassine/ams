// Catalog editions and versions (DEC-046, step 4). An edition is one academic year's catalog; its versions are frozen snapshots of everything
// the catalog prints. The snapshot is plain data so a published version renders without the live records.
import { z } from 'zod';

export interface SnapOutcome { code: string; textEn: string; textAr: string | null }
export interface SnapProgram {
  code: string; nameEn: string; nameAr: string | null; type: 'degree' | 'minor'; level: string; unit: string | null; college: string | null;
  mode: string | null; credits: number | null; durationYears: number | null; contactHours: number | null; language: string | null; mission: string | null; vision: string | null; description: string | null; descriptionAr?: string | null;
  peos: SnapOutcome[]; plos: (SnapOutcome & { ilos: string[] })[];
  concentrations: { code: string; nameEn: string; nameAr: string | null }[];
  blocks: { concentration: string | null; block: string; requirement: string; credits: number }[];
  /** A row's concentrations (codes); none: every student of the program (DEC-047). */
  plan: { course: string; role: string; block: string | null; concentrations: string[]; year: number | null; term: number | null }[];
  /** What applies to the program: its own credits, else the institution's; each area's minimum, its own else the institution's. */
  gened: { credits: number | null; freeElectiveCredits: number | null; areas: { code: string; minCredits: number }[] };
  slots: { concentration: string | null; block: string; requirement: string; area: string | null; name: string; rule: string | null; credits: number; year: number | null; term: number | null }[];
}
export interface SnapCourse {
  code: string; titleEn: string; credits: number | null; lecture: number | null; lab: number | null; other: number | null; unit: string | null; year: number | null;
  description: string | null; language: string | null; prerequisites: string[][]; corequisites: string[][]; otherRequirements: string | null;
}
export interface SnapIlo { code: string; textEn: string; textAr: string | null }
/** Everything a catalog prints, as it stood when the version was published. Course content is the approved content only. */
export interface CatalogSnapshot {
  schema: 1;
  generatedAt: string;
  institution: { nameEn: string; nameAr: string | null; mission: string | null; vision: string | null };
  /** The institution's defaults (a program's own values are on the program). */
  gened: { credits: number | null; freeElectiveCredits?: number | null; areas: { code: string; nameEn: string; nameAr: string | null; minCredits: number; courses: string[] }[] };
  ilos: SnapIlo[];
  programs: SnapProgram[];
  courses: SnapCourse[];
}
/** Plain data, described by the interface above (not re-validated: it is written only by `buildCatalogSnapshot`). */
export const CatalogSnapshotSchema = z.any() as unknown as z.ZodType<CatalogSnapshot, CatalogSnapshot>;

export const CatalogChangeSchema = z.object({ area: z.string(), subject: z.string(), text: z.string() });
export type CatalogChange = z.infer<typeof CatalogChangeSchema>;

export const CatalogVersionSummarySchema = z.object({
  id: z.uuid(), editionId: z.uuid(), versionNo: z.number().int(), note: z.string().nullable(), publishedAt: z.string(), publishedByName: z.string().nullable(), changeCount: z.number().int(),
});
export type CatalogVersionSummary = z.infer<typeof CatalogVersionSummarySchema>;
export const CatalogEditionSchema = z.object({ id: z.uuid(), label: z.string(), status: z.enum(['working', 'closed']), versions: z.array(CatalogVersionSummarySchema) });
export type CatalogEdition = z.infer<typeof CatalogEditionSchema>;
/** The editions, and the draft of the working one: what the live data would add as the next version. */
export const CatalogEditionsSchema = z.object({
  editions: z.array(CatalogEditionSchema),
  /** The working edition, if any. */
  workingId: z.uuid().nullable(),
  draft: z.object({ nextVersionNo: z.number().int(), changes: z.array(CatalogChangeSchema), problems: z.array(z.string()) }).nullable(),
});
export type CatalogEditions = z.infer<typeof CatalogEditionsSchema>;
export const CatalogVersionSchema = CatalogVersionSummarySchema.extend({ editionLabel: z.string(), changes: z.array(CatalogChangeSchema), snapshot: CatalogSnapshotSchema });
export type CatalogVersion = z.infer<typeof CatalogVersionSchema>;

export const StartEditionSchema = z.object({ label: z.string().trim().min(1).max(40) }).strict();
export type StartEdition = z.infer<typeof StartEditionSchema>;
export const PublishVersionSchema = z.object({ note: z.string().trim().max(2000).nullable().optional() }).strict();
export type PublishVersion = z.infer<typeof PublishVersionSchema>;
