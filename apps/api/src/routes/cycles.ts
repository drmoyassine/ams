// Quality Management cycles (TASK-078, DEC-029): templates, cycles, stages, outputs (with file upload and download), inputs,
// approvals and "my work". Reads need cycle:read. Creating and changing templates, launching, owners, dates and cancelling need
// cycle:manage (the service checks it at the cycle's unit). Working a stage is a person's own affair: the coarse gate is
// cycle:read and the service lets in the stage owner, the named approver, and anyone with cycle:work for the unit - so a viewer
// who owns a stage can work it. Every mutation answers with an X-Undo header where it can be taken back.
import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  activateCycle, addInput, addOutput, addStage, cancelCycle, completeStage, createTemplate, decideApproval, deleteCycle, deleteInput, deleteOutput, deleteStage, deleteTemplate,
  finalizeOutput, getCycle, getMyWork, listStageInputs, getTemplate, launchCycle, listCycles, listTemplates, MAX_UPLOAD_BYTES, publishTemplate, readOutputFile, reinstateTemplate, removeOutputFile,
  reopenOutput, reopenStage, resetStage, retireTemplate, reviseTemplate, revertCycleToDraft, setInputPick, setOutputNote, skipStage, startStage, toggleChecklist, updateCycle,
  updateOutput, updateStage, updateTemplate, uploadOutputFile, validateTemplate, ValidationError,
} from '@ams/core';
import {
  AddInputSchema, AddOutputSchema, AddStageSchema, CancelCycleSchema, ChecklistToggleSchema, CreateCycleTemplateSchema, CycleDetailSchema, CycleFilterSchema, CycleInputSchema, CycleSummarySchema,
  CycleTemplateSchema, CYCLE_TEMPLATE_STATUSES, CYCLE_ANCHOR_KINDS, DecideSchema, DeleteResultSchema, LaunchCycleSchema, MyWorkSchema, SetNoteSchema, SetPickSchema, SkipStageSchema,
  TemplateValidationSchema, UpdateCycleSchema, UpdateCycleTemplateSchema, UpdateOutputSchema, UpdateStageSchema, ValidateTemplateSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const INLINE = /^(application\/pdf|image\/(png|jpeg|gif|webp))$/;
const detail = (v: unknown) => toDto(CycleDetailSchema, v);

export function cycleRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['cycles'];
  const read = requires('cycle:read');
  const manage = requires('cycle:manage');
  const cycleOk = (description: string) => ({ 200: { description, ...json(CycleDetailSchema) }, ...errors });
  return new OpenAPIHono<AppEnv>(options)
    // ---- Templates (Settings -> Quality Management) -----------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/cycle-templates', access: read, tags: tag,
      description: 'Cycle templates, by name. Filter by status, or by an anchor kind (templates that fit it).',
      request: { query: z.object({ status: z.enum(CYCLE_TEMPLATE_STATUSES).optional(), anchorKind: z.enum(CYCLE_ANCHOR_KINDS).optional() }) },
      responses: { 200: { description: 'Templates', ...json(z.array(CycleTemplateSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CycleTemplateSchema), await listTemplates(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-templates/validate', access: read, tags: tag,
      description: 'Checks stage definitions without saving: shape, unique keys, inputs reading earlier outputs, no loops. For the template editor.',
      request: { body: { required: true, ...json(ValidateTemplateSchema) } },
      responses: { 200: { description: 'Every problem found', ...json(TemplateValidationSchema) }, ...errors },
    }), async (c) => c.json(await validateTemplate(c.get('ctx'), c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-templates', access: manage, tags: tag,
      description: 'Creates a draft template.',
      request: { body: { required: true, ...json(CreateCycleTemplateSchema) } },
      responses: { 201: { description: 'Created', ...json(CycleTemplateSchema) }, ...errors },
    }), async (c) => c.json(toDto(CycleTemplateSchema, await createTemplate(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/cycle-templates/{id}', access: read, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The template', ...json(CycleTemplateSchema) }, ...errors },
    }), async (c) => c.json(toDto(CycleTemplateSchema, await getTemplate(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/cycle-templates/{id}', access: manage, tags: tag,
      description: 'Edits a draft template. A published one is revised into a draft first.',
      request: { params: idParam, body: { required: true, ...json(UpdateCycleTemplateSchema) } },
      responses: { 200: { description: 'Updated', ...json(CycleTemplateSchema) }, ...errors },
    }), async (c) => c.json(toDto(CycleTemplateSchema, await updateTemplate(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/cycle-templates/{id}', access: manage, tags: tag,
      description: 'Deletes a template that was never published.',
      request: { params: idParam }, responses: { 204: { description: 'Deleted' }, ...errors },
    }), async (c) => { await deleteTemplate(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-templates/{id}/publish', access: manage, tags: tag,
      description: 'Checks the stages in full, raises the version by one and offers the template for launching.',
      request: { params: idParam }, responses: { 200: { description: 'Published', ...json(CycleTemplateSchema) }, ...errors },
    }), async (c) => c.json(toDto(CycleTemplateSchema, await publishTemplate(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-templates/{id}/retire', access: manage, tags: tag,
      request: { params: idParam }, responses: { 200: { description: 'Retired', ...json(CycleTemplateSchema) }, ...errors },
    }), async (c) => c.json(toDto(CycleTemplateSchema, await retireTemplate(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-templates/{id}/reinstate', access: manage, tags: tag,
      request: { params: idParam }, responses: { 200: { description: 'Offered again', ...json(CycleTemplateSchema) }, ...errors },
    }), async (c) => c.json(toDto(CycleTemplateSchema, await reinstateTemplate(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-templates/{id}/revise', access: manage, tags: tag,
      description: 'Turns a published or retired template back into a draft.',
      request: { params: idParam }, responses: { 200: { description: 'A draft again', ...json(CycleTemplateSchema) }, ...errors },
    }), async (c) => c.json(toDto(CycleTemplateSchema, await reviseTemplate(c.get('ctx'), c.req.valid('param').id)), 200))

    // ---- My work --------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/my-cycle-work', access: read, tags: tag,
      description: 'The stages I own in running cycles and the approvals waiting for my decision.',
      responses: { 200: { description: 'My work', ...json(MyWorkSchema) }, ...errors },
    }), async (c) => c.json(toDto(MyWorkSchema, await getMyWork(c.get('ctx'))), 200))

    // ---- Cycles ---------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/cycles', access: read, tags: tag,
      description: 'Cycles, newest first, with the anchor, subject, unit and people named. Filter by anchor, subject, responsible unit, status, an owner (the cycle\'s or a stage\'s), template and words in the title.',
      request: { query: CycleFilterSchema },
      responses: { 200: { description: 'Cycles', ...json(z.array(CycleSummarySchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CycleSummarySchema), await listCycles(c.get('ctx'), c.req.valid('query'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycles', access: manage, tags: tag,
      description: 'Launches a cycle from a published template (or blank): a draft whose stages have their unit and owner resolved from the template\'s rules (unresolved ones are left empty and flagged), dates from the offsets and inputs wired. Start it with /activate.',
      request: { body: { required: true, ...json(LaunchCycleSchema) } },
      responses: { 201: { description: 'The draft cycle', ...json(CycleDetailSchema) }, ...errors },
    }), async (c) => c.json(detail(await launchCycle(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/cycles/{id}', access: read, tags: tag,
      request: { params: idParam },
      responses: cycleOk('The cycle with its stages, outputs and inputs'),
    }), async (c) => c.json(detail(await getCycle(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/cycles/{id}', access: manage, tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateCycleSchema) } },
      responses: cycleOk('Updated'),
    }), async (c) => c.json(detail(await updateCycle(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/cycles/{id}', access: manage, tags: tag,
      description: 'Deletes a DRAFT cycle to the Trash (with its stages, outputs and inputs). A cycle that has started is cancelled instead.',
      request: { params: idParam },
      responses: { 200: { description: 'Deleted to the Trash', ...json(DeleteResultSchema) }, ...errors },
    }), async (c) => c.json(await deleteCycle(c.get('ctx'), { id: c.req.valid('param').id }), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycles/{id}/activate', access: manage, tags: tag,
      description: 'Starts a draft cycle: its stages can then be worked.',
      request: { params: idParam }, responses: cycleOk('Active'),
    }), async (c) => c.json(detail(await activateCycle(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycles/{id}/revert-to-draft', access: manage, tags: tag,
      description: 'Takes a started cycle back to a draft, while no stage has started.',
      request: { params: idParam }, responses: cycleOk('A draft again'),
    }), async (c) => c.json(detail(await revertCycleToDraft(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycles/{id}/cancel', access: manage, tags: tag,
      description: 'Cancels a started cycle; a reason is required and kept.',
      request: { params: idParam, body: { required: true, ...json(CancelCycleSchema) } }, responses: cycleOk('Cancelled'),
    }), async (c) => c.json(detail(await cancelCycle(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    // ---- Stages ---------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycles/{id}/stages', access: manage, tags: tag,
      description: 'Adds a stage to a draft cycle (a blank cycle is built this way).',
      request: { params: idParam, body: { required: true, ...json(AddStageSchema) } }, responses: { 201: { description: 'The cycle with the new stage', ...json(CycleDetailSchema) }, ...errors },
    }), async (c) => c.json(detail(await addStage(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/cycle-stages/{id}', access: manage, tags: tag,
      description: 'Name, instructions, responsible unit, owner and dates of a stage.',
      request: { params: idParam, body: { required: true, ...json(UpdateStageSchema) } }, responses: cycleOk('Updated'),
    }), async (c) => c.json(detail(await updateStage(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/cycle-stages/{id}', access: manage, tags: tag,
      description: 'Removes a stage from a draft cycle, unless another stage reads one of its outputs.',
      request: { params: idParam }, responses: cycleOk('The cycle without the stage'),
    }), async (c) => c.json(detail(await deleteStage(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-stages/{id}/start', access: read, tags: tag,
      description: 'The stage owner (or anyone with cycle:work for its unit) starts the stage. Inputs that are still missing do not stop it.',
      request: { params: idParam }, responses: cycleOk('Started'),
    }), async (c) => c.json(detail(await startStage(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-stages/{id}/reset', access: read, tags: tag,
      description: 'Puts a started stage back to "not started", while nothing in it has been filled (the Undo of starting).',
      request: { params: idParam }, responses: cycleOk('Not started again'),
    }), async (c) => c.json(detail(await resetStage(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-stages/{id}/complete', access: read, tags: tag,
      description: 'Completes the stage: every required output must be final (409 names those that are not). The cycle completes with its last stage.',
      request: { params: idParam }, responses: cycleOk('Completed'),
    }), async (c) => c.json(detail(await completeStage(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-stages/{id}/skip', access: read, tags: tag,
      description: 'Skips a stage that does not apply; the reason is required and kept.',
      request: { params: idParam, body: { required: true, ...json(SkipStageSchema) } }, responses: cycleOk('Skipped'),
    }), async (c) => c.json(detail(await skipStage(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-stages/{id}/reopen', access: read, tags: tag,
      description: 'Reopens a completed stage (a completed cycle runs again) or a skipped one.',
      request: { params: idParam }, responses: cycleOk('Reopened'),
    }), async (c) => c.json(detail(await reopenStage(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-stages/{id}/checklist', access: read, tags: tag,
      description: 'Ticks or unticks one item of the stage\'s checklist.',
      request: { params: idParam, body: { required: true, ...json(ChecklistToggleSchema) } }, responses: cycleOk('Updated'),
    }), async (c) => c.json(detail(await toggleChecklist(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    // ---- Outputs --------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-stages/{id}/outputs', access: manage, tags: tag,
      description: 'Adds an output slot to a stage of a draft cycle.',
      request: { params: idParam, body: { required: true, ...json(AddOutputSchema) } }, responses: { 201: { description: 'The cycle with the new output', ...json(CycleDetailSchema) }, ...errors },
    }), async (c) => c.json(detail(await addOutput(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/cycle-outputs/{id}', access: manage, tags: tag,
      description: 'Who signs an approval (until it has been decided).',
      request: { params: idParam, body: { required: true, ...json(UpdateOutputSchema) } }, responses: cycleOk('Updated'),
    }), async (c) => c.json(detail(await updateOutput(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/cycle-outputs/{id}', access: manage, tags: tag,
      description: 'Removes an output slot from a draft cycle, unless an input reads it.',
      request: { params: idParam }, responses: cycleOk('The cycle without the output'),
    }), async (c) => c.json(detail(await deleteOutput(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/cycle-outputs/{id}/note', access: read, tags: tag,
      description: 'Writes the text of a note output (an empty text makes it missing again).',
      request: { params: idParam, body: { required: true, ...json(SetNoteSchema) } }, responses: cycleOk('Saved'),
    }), async (c) => c.json(detail(await setOutputNote(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-outputs/{id}/finalize', access: read, tags: tag,
      description: 'Marks an output final. A document needs its file, a note its text. A report output is a stub until the report engine exists (TASK-085); it can be marked final by hand and says "report pending".',
      request: { params: idParam }, responses: cycleOk('Final'),
    }), async (c) => c.json(detail(await finalizeOutput(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-outputs/{id}/reopen', access: read, tags: tag,
      description: 'Takes a final output back to a draft. A decided approval is not reopened.',
      request: { params: idParam }, responses: cycleOk('A draft again'),
    }), async (c) => c.json(detail(await reopenOutput(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/cycle-outputs/{id}/file', access: read, tags: tag,
      description: 'The request body is the file itself (Content-Type recorded; the name is `fileName`). Replaces the output\'s file; the output is a draft until marked final.',
      request: { params: idParam, query: z.object({ fileName: z.string().min(1) }) }, responses: cycleOk('Stored'),
    }), async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES) throw new ValidationError(`the file is larger than ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB`);
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const mime = (c.req.header('content-type') ?? 'application/octet-stream').split(';')[0]!.trim();
      return c.json(detail(await uploadOutputFile(c.get('ctx'), c.req.valid('param').id, { fileName: c.req.valid('query').fileName, mime, bytes })), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/cycle-outputs/{id}/file', access: read, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The stored file', content: { 'application/octet-stream': { schema: z.string() } } }, ...errors },
    }), async (c) => {
      const f = await readOutputFile(c.get('ctx'), c.req.valid('param').id);
      const disposition = `${INLINE.test(f.mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.fileName)}`;
      return c.body(f.bytes as unknown as ArrayBuffer, 200, { 'content-type': f.mime, 'content-disposition': disposition, 'x-content-type-options': 'nosniff' }) as never;
    })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/cycle-outputs/{id}/file', access: read, tags: tag,
      request: { params: idParam }, responses: cycleOk('Removed'),
    }), async (c) => c.json(detail(await removeOutputFile(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-outputs/{id}/decision', access: read, tags: tag,
      description: 'The named approver decides an approval: approved, approved_with_conditions or returned (a comment is required for the last two). Nobody else can, whatever their role (403). "returned" reopens the stage that produced what was reviewed. The wording is "Internally approved": an internal sign-off, never an official status.',
      request: { params: idParam, body: { required: true, ...json(DecideSchema) } }, responses: cycleOk('Decided'),
    }), async (c) => c.json(detail(await decideApproval(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    // ---- Inputs ---------------------------------------------------------------------------------------------------------
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/cycle-stages/{id}/inputs', access: read, tags: tag,
      description: 'What a stage reads, each with the output it points at and whether it is satisfied (a final output, or a filled pick). Missing inputs never block a stage.',
      request: { params: idParam },
      responses: { 200: { description: 'The stage\'s inputs', ...json(z.array(CycleInputSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(CycleInputSchema), await listStageInputs(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/cycle-stages/{id}/inputs', access: manage, tags: tag,
      description: 'Adds an input to a stage of a draft cycle: an output of an earlier stage, the previous run\'s output, or something to pick.',
      request: { params: idParam, body: { required: true, ...json(AddInputSchema) } }, responses: { 201: { description: 'The cycle with the new input', ...json(CycleDetailSchema) }, ...errors },
    }), async (c) => c.json(detail(await addInput(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/cycle-inputs/{id}', access: manage, tags: tag,
      request: { params: idParam }, responses: cycleOk('The cycle without the input'),
    }), async (c) => c.json(detail(await deleteInput(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'put', path: '/api/cycle-inputs/{id}/pick', access: read, tags: tag,
      description: 'Fills (or clears, with nulls) a picked input with a document, an evidence item or a standard of this institution.',
      request: { params: idParam, body: { required: true, ...json(SetPickSchema) } }, responses: cycleOk('Saved'),
    }), async (c) => c.json(detail(await setInputPick(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200));
}
