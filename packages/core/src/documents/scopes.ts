// The scope registry (TASK-075, docs/ai-import.md): which places have a Docs tab, what permission reads and writes there,
// where the documents are stored, how to name the place and where to link to it. Every document service and every import goes
// through it, so a new place is one registration here (plus its tab in the SPA).
import { eq } from 'drizzle-orm';
import { frameworkVersion } from '@ams/db';
import type { DocScopeKind, Permission, Scope } from '@ams/shared';
import type { Ctx } from '../ctx.js';
import { ConflictError, ForbiddenError, NotFoundError } from '../ctx.js';
import { isPermitted } from '../permissions.js';
import { placeOf, versionInfo } from '../trash/delete.js';

export interface ScopeDescription {
  /** The place in words: "Programs", "Council Handbook 2023". */
  label: string;
  /** Where its Docs tab is in the app (a path with its query). */
  href: string;
  /** False when the place is fixed (a published version): documents and imports cannot change there. */
  editable: boolean;
  /** Why it is not editable, in words (shown instead of the upload area). */
  fixedReason?: string;
}

export interface DocScopeDef {
  kind: DocScopeKind;
  /** The place's name when it has no id of its own ("Programs"). */
  label: string;
  /**
   * 'import': uploads are `import_document` rows. 'source': the standards adapter, rows are `source_document` and every action
   * delegates to the existing source services.
   */
  storage: 'import' | 'source';
  /** The permission that lets a person see the place's documents and import history. */
  read: Permission;
  /** The permission that lets a person upload, delete and import there. */
  write: Permission;
  /** The permission scope for reading (default: anywhere the person holds the permission) and writing (default: the institution). */
  readScope?: (scopeId: string | null) => Scope;
  writeScope?: (scopeId: string | null) => Scope;
  /** Names the place and says whether it can change. Returns null when the place does not exist (any more). */
  describe(ctx: Ctx, scopeId: string | null): Promise<ScopeDescription | null>;
}

const registry = new Map<DocScopeKind, DocScopeDef>();

/** Registers (or replaces) a scope. The built-in ones are below; a new place adds its own next to them. */
export function registerDocScope(def: DocScopeDef): void {
  registry.set(def.kind, def);
}

export function getDocScope(kind: string): DocScopeDef {
  const def = registry.get(kind as DocScopeKind);
  if (!def) throw new NotFoundError(`document scope ${kind}`);
  return def;
}

export const docScopes = (): DocScopeDef[] => [...registry.values()];

const fixed = (label: string, href: string): ScopeDescription => ({ label, href, editable: true });

registerDocScope({
  kind: 'framework_version', label: 'Standards version', storage: 'source', read: 'framework:read', write: 'framework:write',
  async describe(ctx, id) {
    if (!id) return null;
    const [v] = await ctx.tx.select({ status: frameworkVersion.status }).from(frameworkVersion).where(eq(frameworkVersion.id, id));
    if (!v) return null;
    const info = await versionInfo(ctx, id);
    const editable = v.status === 'draft';
    return {
      label: placeOf(info), href: `/settings/versions/${id}?tab=docs`, editable,
      ...(editable ? {} : { fixedReason: `The documents of a ${v.status === 'in_review' ? 'version in review' : 'published version'} are fixed with it; start a new version to change them.` }),
    };
  },
});
// The three upload scopes. The links point at where each Docs tab lives; update the href when the tab moves.
registerDocScope({
  kind: 'programs', label: 'Programs', storage: 'import', read: 'org:read', write: 'program:write',
  describe: async () => fixed('Programs', '/settings/organization?tab=programs'),
});
registerDocScope({
  kind: 'org_chart', label: 'Org chart', storage: 'import', read: 'org:read', write: 'org:write',
  describe: async () => fixed('Org chart', '/settings/organization?tab=institution'),
});
registerDocScope({
  kind: 'glossary', label: 'Glossary', storage: 'import', read: 'framework:read', write: 'framework:write',
  describe: async () => fixed('Glossary', '/settings/glossary?section=docs'),
});

export const scopeKey = (kind: string, id: string | null) => (id ? `${kind}:${id}` : kind);

export async function canReadScope(ctx: Ctx, def: DocScopeDef, scopeId: string | null): Promise<boolean> {
  return isPermitted(ctx.tx, def.read, def.readScope?.(scopeId) ?? { type: 'any' });
}
export async function canWriteScope(ctx: Ctx, def: DocScopeDef, scopeId: string | null): Promise<boolean> {
  return isPermitted(ctx.tx, def.write, def.writeScope?.(scopeId) ?? { type: 'institution' });
}

/** The scope must exist and the caller must be allowed to read its documents. */
export async function assertCanRead(ctx: Ctx, kind: string, scopeId: string | null): Promise<{ def: DocScopeDef; place: ScopeDescription }> {
  const def = getDocScope(kind);
  if (!(await canReadScope(ctx, def, scopeId))) throw new ForbiddenError(`Missing permission ${def.read}`);
  const place = await def.describe(ctx, scopeId);
  if (!place) throw new NotFoundError(`${def.label} ${scopeId ?? ''}`.trim());
  return { def, place };
}

/** The caller must be allowed to change the scope's documents; with `editable` the place must also be open to change. */
export async function assertCanWrite(ctx: Ctx, kind: string, scopeId: string | null, opts: { editable?: boolean } = {}): Promise<{ def: DocScopeDef; place: ScopeDescription }> {
  const def = getDocScope(kind);
  if (!(await canWriteScope(ctx, def, scopeId))) throw new ForbiddenError(`Missing permission ${def.write}`);
  const place = await def.describe(ctx, scopeId);
  if (!place) throw new NotFoundError(`${def.label} ${scopeId ?? ''}`.trim());
  if (opts.editable !== false && !place.editable) throw new ConflictError(place.fixedReason ?? `${place.label} cannot be changed now`);
  return { def, place };
}

/** The place's name in words, for prompts and messages; falls back to the kind's label when the place is gone. */
export async function describeScope(ctx: Ctx, kind: string, scopeId: string | null): Promise<string> {
  const def = getDocScope(kind);
  return (await def.describe(ctx, scopeId))?.label ?? def.label;
}
