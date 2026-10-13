// The assistant's PROPOSE tools (Phase 2, DEC-027). None of them changes anything: `propose_changes` turns the operations the model
// chose into a plan, checks it, and shows the person a card in the chat; `create_draft_proposal` does the same for "start a new
// draft"; `find_requirements` and `draft_rewrites` help build the operations. There is deliberately NO tool that applies a change:
// applying is the person's "Do it" press (a one-time confirmation token the model cannot obtain), made by the API, not by a job.
import { z } from 'zod';
import {
  ChangeSetInputSchema, MAX_ITEM_CHANGES, REWRITE_FIELDS, RequirementFilterSchema, type AssistantLink, type ChangeSetInput,
} from '@ams/shared';
import { ForbiddenError } from '../../ctx.js';
import { require_ } from '../../framework/common.js';
import { RowIndex, matchFilter, type ReqRow } from '../changes/filter.js';
import { buildProposalPart } from '../changes/proposal.js';
import { loadRows, loadVersionFacts, planChangeSet } from '../changes/plan.js';
import type { Ctx } from '../../ctx.js';
import { clip, defineTool, plural, type ToolEnv, type ToolOutput } from './types.js';

const versionId = z.uuid().describe('The id of the version (from list_versions, or the screen context).');
const MAX_FOUND = 25;
const REWRITE_BATCH = 15;
const MAX_REWRITE_ITEMS = 200;

const reqLink = (r: { id: string; code: string; title: string }, vId: string): AssistantLink => ({ kind: 'requirement', id: r.id, versionId: vId, code: r.code, label: clip(`${r.code} ${r.title}`, 80) });
const noWrite = (): ToolOutput => ({
  refused: true, data: { refused: true, message: 'The person does not have permission to change standards, so you cannot propose changes. Say so plainly.' },
  summary: 'Not allowed to change standards', links: [],
});

// ---- find_requirements ---------------------------------------------------------------------------------------------------------
export const findRequirementsTool = defineTool({
  name: 'find_requirements', access: 'read',
  description: 'Counts and lists the requirements of one version that match a FILTER: the same filter you give to the operations of propose_changes, so you can check what an operation would touch before proposing it. Conditions combine with AND. Returns the total and at most 25 examples.',
  input: z.object({ versionId, filter: RequirementFilterSchema, limit: z.number().int().min(1).max(MAX_FOUND).default(10) }).strict(),
  describeArgs: (a) => `items matching ${Object.keys(a.filter).filter((k) => (a.filter as Record<string, unknown>)[k] !== undefined).join(', ') || 'everything'}`,
  async execute(ctx, args) {
    await require_(ctx, 'framework:read');
    const { rows, noteCounts } = await loadRows(ctx, args.versionId);
    const index = new RowIndex(rows, noteCounts);
    const found = matchFilter(index, args.filter);
    if (found.problems.length) return { data: { error: found.problems.join('; ') }, summary: clip(found.problems[0]!, 100), links: [] };
    const shown = found.rows.slice(0, args.limit);
    const data = {
      matches: found.rows.length, shown: shown.length,
      requirements: shown.map((r: ReqRow) => ({
        requirementId: r.id, code: r.code, title: clip(r.title, 160), level: r.levelLabel, depth: index.depth(r.id), parentCode: r.parentId ? index.byId.get(r.parentId)?.code ?? null : null,
        assessable: r.isAssessable, descriptionStart: clip(r.officialText, 160) || null, subItems: (index.children.get(r.id) ?? []).length, notes: noteCounts.get(r.id) ?? 0,
      })),
    };
    return { data, summary: `${plural(found.rows.length, 'item')} match`, links: shown.slice(0, 8).map((r) => reqLink(r, args.versionId)) };
  },
});

// ---- draft_rewrites ---------------------------------------------------------------------------------------------------------------
export const draftRewritesTool = defineTool({
  name: 'draft_rewrites', access: 'propose',
  description: 'For TEXT edits that need judgement (translate, tidy OCR errors, write short titles): asks the model to write a new text for each matching item, in batches. It changes nothing and returns a setId plus a few samples; then call propose_changes with a rewrite_text operation using that setId. Use rule operations instead whenever a rule can do the job. At most 200 items per call.',
  input: z.object({
    versionId,
    field: z.enum(REWRITE_FIELDS).describe('The field that gets the new text. translationEn: an English translation kept beside the original.'),
    instruction: z.string().trim().min(3).max(500).describe('What to do to each text, in plain words (the person\'s request).'),
    filter: RequirementFilterSchema.optional(),
    limit: z.number().int().min(1).max(MAX_REWRITE_ITEMS).default(60),
  }).strict(),
  describeArgs: (a) => `write new ${a.field === 'officialText' ? 'descriptions' : a.field === 'translationEn' ? 'translations' : 'titles'}: ${clip(a.instruction, 60)}`,
  async execute(ctx, args, env) {
    try { await require_(ctx, 'framework:write'); } catch (e) { if (e instanceof ForbiddenError) return noWrite(); throw e; }
    if (!env.rewrite) return { data: { error: 'writing texts is not available here' }, summary: 'Cannot write texts here', links: [] };
    const { rows, noteCounts } = await loadRows(ctx, args.versionId);
    const found = matchFilter(new RowIndex(rows, noteCounts), args.filter);
    if (found.problems.length) return { data: { error: found.problems.join('; ') }, summary: clip(found.problems[0]!, 100), links: [] };
    const source = (r: ReqRow) => (args.field === 'title' ? r.title : args.field === 'officialText' ? r.officialText : (r.officialText ?? r.title)) ?? '';
    const targets = found.rows.filter((r) => source(r).trim()).slice(0, args.limit);
    if (!targets.length) return { data: { error: 'no matching item has text to rewrite' }, summary: 'Nothing to rewrite', links: [] };
    const written: { id: string; text: string }[] = [];
    const failed: string[] = [];
    let partial: string | null = null;
    for (let i = 0; i < targets.length; i += REWRITE_BATCH) {
      const batch = targets.slice(i, i + REWRITE_BATCH);
      try {
        const out = await env.rewrite({ instruction: args.instruction, field: args.field, items: batch.map((r) => ({ id: r.id, code: r.code, text: source(r) })) });
        const byId = new Map(out.map((o) => [o.id, o.text]));
        for (const r of batch) {
          const text = (byId.get(r.id) ?? '').normalize('NFC').trim();
          const max = Math.max(600, source(r).length * 4 + 400);
          if (!text) failed.push(r.code); else if (text.length > max) failed.push(r.code); else written.push({ id: r.id, text });
        }
      } catch (e) {
        partial = e instanceof Error ? e.message.slice(0, 160) : 'the writing stopped';
        break;
      }
    }
    const setId = `rw-${(env.rewriteSets ??= new Map()).size + 1}`;
    env.rewriteSets.set(setId, { versionId: args.versionId, field: args.field, instruction: args.instruction, items: written });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const data = {
      setId, written: written.length, requested: targets.length, notWritten: failed.slice(0, 20),
      ...(partial ? { stoppedEarly: `Stopped before the end: ${partial}. Tell the person how many were written and that they can ask for the rest.` } : {}),
      samples: written.slice(0, 3).map((w) => ({ code: byId.get(w.id)?.code, before: clip(source(byId.get(w.id)!), 200), after: clip(w.text, 200) })),
      next: 'Call propose_changes with a rewrite_text operation {field, instruction, setId}. Nothing is changed yet.',
    };
    return { data, summary: `Wrote ${plural(written.length, 'new text')} for review${partial ? ' (stopped early)' : ''}`, links: [] };
  },
});

// ---- propose_changes -------------------------------------------------------------------------------------------------------------
/** Copies the texts of `draft_rewrites` sets into the rewrite_text operations that name them, so the proposal holds every word it would write. */
function expandRewrites(input: ChangeSetInput, sets: Map<string, { versionId: string; items: { id: string; text: string }[] }> | undefined): { input: ChangeSetInput } | { error: string } {
  const operations = [];
  for (const op of input.operations) {
    if (op.op === 'rewrite_text' && op.setId) {
      const set = sets?.get(op.setId);
      if (!set) return { error: `there is no set of written texts called ${op.setId} in this turn; call draft_rewrites first` };
      if (set.versionId !== input.versionId) return { error: 'those texts were written for another version' };
      operations.push({ op: 'rewrite_text' as const, field: op.field, ...(op.instruction ? { instruction: op.instruction } : {}), items: set.items });
    } else operations.push(op);
  }
  const parsed = ChangeSetInputSchema.safeParse({ ...input, operations });
  return parsed.success ? { input: parsed.data } : { error: parsed.error.issues[0]?.message ?? 'the operations are not valid' };
}

async function propose(ctx: Ctx, input: ChangeSetInput, env: ToolEnv): Promise<ToolOutput> {
  const plan = await planChangeSet(ctx, input);
  if (plan.problems.length) {
    return {
      data: { proposed: false, problems: plan.problems, skipped: plan.skipped.slice(0, 10), advice: 'Nothing was proposed. Explain the problem to the person in plain words and ask how to proceed; do not claim any change.' },
      summary: `Could not propose: ${clip(plan.problems[0], 90)}`, links: [],
    };
  }
  if (plan.items === 0) {
    return {
      data: { proposed: false, nothingToChange: true, skipped: plan.skipped.slice(0, 10), advice: 'No item would change. Tell the person that, and why if skipped items explain it.' },
      summary: 'Nothing would change', links: [],
    };
  }
  const part = buildProposalPart(crypto.randomUUID(), input, plan);
  env.emit(part);
  const data = {
    proposed: true, applied: false, versionLabel: plan.versionLabel, items: plan.items, byOperation: plan.counts.byOperation, examples: plan.examples, skipped: plan.skipped.slice(0, 10), skippedCount: plan.skippedCount,
    deletes: plan.deletes.slice(0, 10), deletesCount: plan.deletesCount, warnings: plan.warnings, remainingItemChanges: plan.remaining, linksByCode: plan.linksByCode, newDraft: plan.newDraft,
    nextSteps: 'NOTHING HAS BEEN CHANGED. A card with the buttons Do it, Change it and Cancel is now shown to the person. Reply with a short plain-words confirmation: what you will do, how many items, two or three examples, anything skipped and why, every delete named, and ask them to press a button. Do not say it is done.',
  };
  return { data, summary: `Proposed a change to ${plural(plan.items, 'item')} in ${plan.versionLabel} (waiting for the person)`, links: [] };
}

export const proposeChangesTool = defineTool({
  name: 'propose_changes', access: 'propose',
  description: [
    'Proposes a bulk edit of one DRAFT version to the person. It changes NOTHING: it checks the operations against the current data (cycles, code collisions, frozen versions, permissions) and shows the person a card with the counts, examples and the buttons Do it / Change it / Cancel. Only their button press applies it; you cannot.',
    'Give an ordered list of operations. Prefer the RECIPES (swap_title_and_description, set_field_by_filter, copy_field, prefix_or_replace_text, recode, reparent_by_rule, delete_by_filter, bulk_set_assessable, bulk_set_level_label): you choose the recipe and its filter, the system computes every row exactly. Use set_fields / set_note_fields / move / create_requirement / merge / split / accept_suggested_links / dismiss_suggested_links for specific items, and rewrite_text (with draft_rewrites) only when judgement is needed.',
    `At most ${MAX_ITEM_CHANGES} item changes are made in one step; a bigger request is cut and the rest is left for the next step: say so. A published version cannot be changed: use create_draft_proposal first.`,
    'Check what a filter matches with find_requirements before proposing.',
  ].join(' '),
  input: ChangeSetInputSchema,
  describeArgs: (a) => clip(a.summary, 80),
  async execute(ctx, args, env) {
    try { await require_(ctx, 'framework:write'); } catch (e) { if (e instanceof ForbiddenError) return noWrite(); throw e; }
    const expanded = expandRewrites(args, env.rewriteSets);
    if ('error' in expanded) return { data: { proposed: false, problems: [expanded.error] }, summary: clip(expanded.error, 100), links: [] };
    return propose(ctx, expanded.input, env);
  },
});

// ---- create_draft_proposal --------------------------------------------------------------------------------------------------------
export const createDraftProposalTool = defineTool({
  name: 'create_draft_proposal', access: 'propose',
  description: 'Proposes starting a NEW DRAFT version as a copy of a version (usually a published one), because published versions cannot be edited. Changes nothing until the person presses Do it. It is a separate confirmed step: the edits to the new draft are proposed afterwards, in a later turn, with propose_changes on the new draft\'s id (look it up with list_versions).',
  input: z.object({
    sourceVersionId: z.uuid().describe('The version to copy.'),
    edition: z.string().trim().min(1).max(80).describe('The edition name for the new draft, e.g. "2025-V2".'),
    changeSummary: z.string().trim().max(500).optional(),
  }).strict(),
  describeArgs: (a) => `new draft ${a.edition}`,
  async execute(ctx, args, env) {
    try { await require_(ctx, 'framework:write'); } catch (e) { if (e instanceof ForbiddenError) return noWrite(); throw e; }
    const facts = await loadVersionFacts(ctx, args.sourceVersionId);
    const parsed = ChangeSetInputSchema.parse({
      versionId: args.sourceVersionId, summary: `Start a new draft, ${args.edition}, as a copy of ${facts.label}`,
      operations: [{ op: 'create_draft', edition: args.edition, ...(args.changeSummary ? { changeSummary: args.changeSummary } : {}) }],
    });
    return propose(ctx, parsed, env);
  },
});

export const CHANGE_TOOLS = [findRequirementsTool, draftRewritesTool, proposeChangesTool, createDraftProposalTool];
