// "Create from files": the owner's main way to add an external standard. One call creates the accreditor (or reuses one), the
// standard and its first draft version, and registers one source per file the person chose, in ONE transaction: either
// everything exists or nothing does. The browser then uploads each file to its source (the existing source file route) and
// starts the analysis (the existing start route), so a failed upload is retried on its own and never loses the draft.
import { and, eq, sql } from 'drizzle-orm';
import { accreditor, framework } from '@ams/db';
import { z } from 'zod';
import type { Ctx } from '../ctx.js';
import { ConflictError, NotFoundError, ValidationError } from '../ctx.js';
import { guardIntegrity } from './errors.js';
import { assertHuman, require_ } from './common.js';
import { MAX_SOURCE_BYTES, addSourceDocument } from './sources.js';
import { createFramework, createVersion } from './versions.js';

export const MAX_FILES_PER_STANDARD = 40;

export const CreateStandardFromFilesSchema = z.object({
  /** An accreditor already in the library... */
  accreditorId: z.uuid().optional(),
  /** ...or a new one (its short name must not be taken). Exactly one of the two. */
  accreditor: z.object({
    name: z.string().trim().min(1, 'give the accreditor a name'),
    shortName: z.string().trim().min(1, 'give the accreditor a short name'),
    type: z.enum(['institutional', 'programmatic', 'regulatory']).optional(),
    country: z.string().trim().min(1).optional(),
  }).optional(),
  name: z.string().trim().min(1, 'give the standard a name'),
  scope: z.enum(['institution', 'program', 'both']),
  edition: z.string().trim().min(1, 'give the edition (a year or a name)'),
  /** The files the person chose, by name (and size, checked against the limit); their bytes follow, one request each. */
  files: z.array(z.object({ name: z.string().trim().min(1).max(300), size: z.number().int().nonnegative().optional() })).min(1, 'add at least one file').max(MAX_FILES_PER_STANDARD, `at most ${MAX_FILES_PER_STANDARD} files at a time`),
}).refine((v) => !!v.accreditorId !== !!v.accreditor, { message: 'choose an existing accreditor or give a new one', path: ['accreditor'] });

const DEFAULT_TYPE = { institution: 'institutional', program: 'programmatic', both: 'institutional' } as const;
/** "Handbook 2026.pdf" -> "Handbook 2026". Arabic names stay as they are (NFC). */
export const titleFromFileName = (name: string) => {
  const base = name.normalize('NFC').split(/[\\/]/).pop()!.trim();
  const stem = base.replace(/\.[\p{L}\p{N}]{1,5}$/u, '').trim();
  return stem || base || 'Source';
};

export interface StandardFromFiles {
  accreditor: { id: string; name: string; shortName: string; created: boolean };
  framework: { id: string; name: string; scope: 'institution' | 'program' | 'both' };
  version: { id: string; edition: string; status: string };
  /** One per file, in the order given. The browser uploads each file to its document. */
  documents: { id: string; title: string; fileName: string }[];
}

export async function createStandardFromFiles(ctx: Ctx, input: z.input<typeof CreateStandardFromFilesSchema>): Promise<StandardFromFiles> {
  await require_(ctx, 'framework:write');
  assertHuman(ctx);
  const parsed = CreateStandardFromFilesSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.length === 1 ? parsed.error.issues[0]!.message : 'cannot create the standard', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const data = parsed.data;
  const tooBig = data.files.find((f) => (f.size ?? 0) > MAX_SOURCE_BYTES);
  if (tooBig) throw new ValidationError(`"${tooBig.name}" is larger than ${Math.round(MAX_SOURCE_BYTES / 1048576)} MB`, [{ path: 'files', message: `${tooBig.name}: too large` }]);

  let acc: typeof accreditor.$inferSelect | undefined;
  let created = false;
  if (data.accreditorId) {
    [acc] = await ctx.tx.select().from(accreditor).where(eq(accreditor.id, data.accreditorId));
    if (!acc) throw new NotFoundError(`accreditor ${data.accreditorId}`);
  } else {
    const a = data.accreditor!;
    const [taken] = await ctx.tx.select({ id: accreditor.id }).from(accreditor).where(sql`lower(${accreditor.shortName}) = lower(${a.shortName})`);
    if (taken) throw new ConflictError(`an accreditor with the short name ${a.shortName} already exists; choose it from the list instead`);
    [acc] = await guardIntegrity(() => ctx.tx.insert(accreditor).values({
      institutionId: ctx.caller.institutionId, name: a.name, shortName: a.shortName, type: a.type ?? DEFAULT_TYPE[data.scope], ...(a.country ? { country: a.country } : {}),
    }).returning());
    created = true;
  }
  const [same] = await ctx.tx.select({ id: framework.id }).from(framework)
    .where(and(eq(framework.accreditorId, acc!.id), sql`lower(${framework.name}) = lower(${data.name})`));
  if (same) throw new ConflictError(`${acc!.shortName} already has a standard called ${data.name}; open it and start a new version, or choose another name`);

  const fw = await createFramework(ctx, { accreditorId: acc!.id, name: data.name, scope: data.scope });
  const version = await createVersion(ctx, { frameworkId: fw.id, edition: data.edition });
  const documents: StandardFromFiles['documents'] = [];
  for (const f of data.files) {
    // No role yet: the analysis proposes one for each file ("the analysis decides").
    const doc = await addSourceDocument(ctx, { versionId: version.id, title: titleFromFileName(f.name), authority: 'binding' });
    documents.push({ id: doc.id, title: doc.title, fileName: f.name });
  }
  return {
    accreditor: { id: acc!.id, name: acc!.name, shortName: acc!.shortName, created },
    framework: { id: fw.id, name: fw.name, scope: fw.scope },
    version: { id: version.id, edition: version.edition, status: version.status },
    documents,
  };
}
