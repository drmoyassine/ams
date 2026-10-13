import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  applyChangeProposal, auditListConversations, auditReadMessages, cancelMessage, confirmChangeProposal, confirmMemoryProposal, createConversation, createMemory,
  declineChangeProposal, declineMemoryProposal, deleteConversation, deleteMemory, getAssistantStatus, getConversation, keepWrittenText, listConversations, listMemory,
  listWrittenTexts, messagesSince, redoChangeSet, renameConversation, revertWrittenText, sendMessage, undoChangeSet, updateMemory,
} from '@ams/core';
import {
  ApplyChangeBodySchema, ApplyChangeResultSchema, AssistantAuditListSchema, AssistantConversationSchema, AssistantMessageSchema, AssistantStatusSchema, ChangeProposalPartSchema,
  ChangeSetStateSchema, ConfirmChangeSchema, ConfirmMemoryProposalSchema, ConversationWithMessagesSchema,
  CreateConversationSchema, CreatedConversationSchema, CreateMemorySchema, MemoryItemSchema, MemoryListQuerySchema, MessagesSinceQuerySchema, MessagesSinceSchema, SendMessageSchema,
  SentTurnSchema, UpdateConversationSchema, UpdateMemorySchema, WrittenTextSchema, toDto,
} from '@ams/shared';
import { requires, scopeFrom, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

/**
 * The in-app assistant (DEC-027). Every route needs a signed-in person who can read the organisation (org:read: every internal
 * role; external reviewers are excluded); what the assistant may SHOW is decided per tool by the person's own permissions, in the
 * job. The API never calls a model: sending a message stores it and queues the `assistant` job.
 */
export function assistantRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['assistant'];
  const base = requires('org:read');
  const rateLimited = { 429: { description: 'Too many assistant questions this hour', ...json(z.object({ error: z.string(), message: z.string().optional() })) } };
  const messageParams = z.object({ messageId: z.uuid(), partId: z.string().min(1).max(64) });
  // Changing standards needs framework:write across the institution, exactly as the screens do; the services check it again.
  const write = requires('framework:write', scopeFrom.institution);
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/assistant/status', access: base, tags: tag,
      responses: { 200: { description: 'Whether the assistant can be used now, and if not why', ...json(AssistantStatusSchema) }, ...errors },
    }), async (c) => c.json(toDto(AssistantStatusSchema, await getAssistantStatus(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/assistant/conversations', access: base, tags: tag,
      responses: { 200: { description: 'The person\'s own conversations, newest first', ...json(z.array(AssistantConversationSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(AssistantConversationSchema), await listConversations(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/conversations', access: base, tags: tag,
      request: { body: { required: true, ...json(CreateConversationSchema) } },
      responses: { 201: { description: 'Created, with the first turn when a first message came with it', ...json(CreatedConversationSchema) }, ...errors, ...rateLimited },
    }), async (c) => c.json(toDto(CreatedConversationSchema, await createConversation(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/assistant/conversations/{id}', access: base, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'One conversation of the person with its messages', ...json(ConversationWithMessagesSchema) }, ...errors },
    }), async (c) => c.json(toDto(ConversationWithMessagesSchema, await getConversation(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/assistant/conversations/{id}', access: base, tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateConversationSchema) } },
      responses: { 200: { description: 'Renamed', ...json(AssistantConversationSchema) }, ...errors },
    }), async (c) => c.json(toDto(AssistantConversationSchema, await renameConversation(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').title)), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/assistant/conversations/{id}', access: base, tags: tag,
      request: { params: idParam },
      responses: { 204: { description: 'Deleted with all its messages' }, ...errors },
    }), async (c) => { await deleteConversation(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/conversations/{id}/messages', access: base, tags: tag,
      request: { params: idParam, body: { required: true, ...json(SendMessageSchema) } },
      description: 'Stores the message with its context chips (checked against what the person may read), adds the assistant\'s placeholder and queues the job. Poll GET .../messages?after= until the placeholder is done.',
      responses: { 201: { description: 'The person\'s message and the assistant\'s queued reply', ...json(SentTurnSchema) }, ...errors, ...rateLimited },
    }), async (c) => c.json(toDto(SentTurnSchema, await sendMessage(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/assistant/conversations/{id}/messages', access: base, tags: tag,
      request: { params: idParam, query: MessagesSinceQuerySchema },
      responses: { 200: { description: 'Messages changed after the cursor (all when none), and the new cursor', ...json(MessagesSinceSchema) }, ...errors },
    }), async (c) => c.json(toDto(MessagesSinceSchema, await messagesSince(c.get('ctx'), c.req.valid('param').id, c.req.valid('query').after)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/messages/{id}/cancel', access: base, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Stopped (best effort: the turn ends at its next step)', ...json(AssistantMessageSchema) }, ...errors },
    }), async (c) => c.json(toDto(AssistantMessageSchema, await cancelMessage(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/memory-proposals/{messageId}/{partId}/confirm', access: base, tags: tag,
      request: { params: messageParams, body: { required: false, ...json(ConfirmMemoryProposalSchema) } },
      description: 'The person saves a "Remember this?" card (optionally edited). The memory is written as them, under the permission rules for its scope.',
      responses: { 201: { description: 'Saved', ...json(MemoryItemSchema) }, ...errors },
    }), async (c) => {
      const p = c.req.valid('param');
      return c.json(toDto(MemoryItemSchema, await confirmMemoryProposal(c.get('ctx'), p.messageId, p.partId, c.req.valid('json') ?? {})), 201);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/memory-proposals/{messageId}/{partId}/decline', access: base, tags: tag,
      request: { params: messageParams },
      responses: { 204: { description: 'Declined; nothing is stored' }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); await declineMemoryProposal(c.get('ctx'), p.messageId, p.partId); return c.body(null, 204); })

    // ---- Bulk edits the person confirms in the chat (DEC-027 Phase 2). The model only PROPOSES; these are the person's button presses. ----
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/change-proposals/{messageId}/{partId}/confirm', access: write, tags: tag,
      request: { params: messageParams },
      description: 'The "Do it" press, step 1. Re-checks the proposal on the data as it is now (a dry run through the services, rolled back) and, only if it holds, issues a one-time token tied to this person, this proposal and the hash of its exact change set (valid ten minutes). Only the proposal\'s owner, only while it is pending.',
      responses: { 200: { description: 'A token (status ready), or the reason the proposal no longer holds (status stale)', ...json(ConfirmChangeSchema) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(toDto(ConfirmChangeSchema, await confirmChangeProposal(c.get('ctx'), p.messageId, p.partId)), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/change-proposals/{messageId}/{partId}/apply', access: write, tags: tag,
      request: { params: messageParams, body: { required: true, ...json(ApplyChangeBodySchema) } },
      description: 'The "Do it" press, step 2. Consumes the token (once), plans again on the current data and, if the result is exactly what was confirmed, applies ALL operations in one transaction as the person through the core services. Answers with ONE undo descriptor (POST /api/assistant/changes/{id}/undo). Nothing is changed when it answers failed or stale.',
      responses: { 200: { description: 'applied, failed or stale, with the updated proposal', ...json(ApplyChangeResultSchema) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(toDto(ApplyChangeResultSchema, await applyChangeProposal(c.get('ctx'), p.messageId, p.partId, c.req.valid('json').token)), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/change-proposals/{messageId}/{partId}/decline', access: write, tags: tag,
      request: { params: messageParams },
      responses: { 200: { description: 'Cancelled; nothing was changed and no token can apply it any more', ...json(ChangeProposalPartSchema) }, ...errors },
    }), async (c) => { const p = c.req.valid('param'); return c.json(toDto(ChangeProposalPartSchema, await declineChangeProposal(c.get('ctx'), p.messageId, p.partId)), 200); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/changes/{id}/undo', access: write, tags: tag,
      request: { params: idParam },
      description: 'Takes a whole applied change set back in one transaction (restores deletes from the Trash, puts earlier values and places back, removes what it created). Answers with the redo descriptor.',
      responses: { 200: { description: 'Undone', ...json(ChangeSetStateSchema) }, ...errors },
    }), async (c) => c.json(toDto(ChangeSetStateSchema, await undoChangeSet(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/changes/{id}/redo', access: write, tags: tag,
      request: { params: idParam },
      description: 'Applies an undone change set again, through the services and their checks; refused with the reason when the world changed (for example the version was published meanwhile).',
      responses: { 200: { description: 'Done again', ...json(ChangeSetStateSchema) }, ...errors },
    }), async (c) => c.json(toDto(ChangeSetStateSchema, await redoChangeSet(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/framework-versions/{id}/assistant-texts', access: requires('framework:read'), tags: tag,
      request: { params: idParam },
      description: 'Texts the assistant wrote in this version that nobody has kept or reverted yet and that still hold exactly what it wrote.',
      responses: { 200: { description: 'The markers', ...json(z.array(WrittenTextSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(WrittenTextSchema), await listWrittenTexts(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/written-texts/{id}/keep', access: write, tags: tag,
      request: { params: idParam },
      responses: { 204: { description: 'Kept; the marker is gone' }, ...errors },
    }), async (c) => { await keepWrittenText(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/written-texts/{id}/revert', access: write, tags: tag,
      request: { params: idParam },
      description: 'Puts back the value the assistant\'s text replaced, as a normal edit (so it can be undone).',
      responses: { 204: { description: 'Reverted' }, ...errors },
    }), async (c) => { await revertWrittenText(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/assistant/memory', access: base, tags: tag,
      request: { query: MemoryListQuerySchema },
      responses: { 200: { description: 'The person\'s memory and the shared memory of scopes they can read', ...json(z.array(MemoryItemSchema)) }, ...errors },
    }), async (c) => {
      const q = c.req.valid('query');
      return c.json(toDto(z.array(MemoryItemSchema), await listMemory(c.get('ctx'), {
        ...(q.scopeType ? { scopeType: q.scopeType } : {}), ...(q.scopeId ? { scopeId: q.scopeId } : {}), ...(q.tab ? { tab: q.tab } : {}), includeArchived: q.includeArchived === 'true',
      })), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/assistant/memory', access: base, tags: tag,
      request: { body: { required: true, ...json(CreateMemorySchema) } },
      responses: { 201: { description: 'Saved', ...json(MemoryItemSchema) }, ...errors },
    }), async (c) => c.json(toDto(MemoryItemSchema, await createMemory(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/assistant/memory/{id}', access: base, tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateMemorySchema) } },
      responses: { 200: { description: 'Updated', ...json(MemoryItemSchema) }, ...errors },
    }), async (c) => c.json(toDto(MemoryItemSchema, await updateMemory(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/assistant/memory/{id}', access: base, tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Archived; deleting an archived memory removes it for good', ...json(z.object({ purged: z.boolean() })) }, ...errors },
    }), async (c) => c.json(await deleteMemory(c.get('ctx'), c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/assistant/audit/conversations', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      request: { query: z.object({ userId: z.uuid().optional() }) },
      description: 'For audit: conversations of other people. Administrators only; every read is recorded in the audit trail.',
      responses: { 200: { description: 'Conversations', ...json(AssistantAuditListSchema) }, ...errors },
    }), async (c) => c.json(toDto(AssistantAuditListSchema, await auditListConversations(c.get('ctx'), c.req.valid('query').userId ? { userId: c.req.valid('query').userId! } : {})), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/assistant/audit/conversations/{id}/messages', access: requires('ai:manage', scopeFrom.institution), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The messages of one conversation, for audit (recorded in the audit trail)', ...json(z.array(AssistantMessageSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(AssistantMessageSchema), await auditReadMessages(c.get('ctx'), c.req.valid('param').id)), 200));
}
