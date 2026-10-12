import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  auditListConversations, auditReadMessages, cancelMessage, confirmMemoryProposal, createConversation, createMemory, declineMemoryProposal, deleteConversation, deleteMemory,
  getAssistantStatus, getConversation, listConversations, listMemory, messagesSince, renameConversation, sendMessage, updateMemory,
} from '@ams/core';
import {
  AssistantAuditListSchema, AssistantConversationSchema, AssistantMessageSchema, AssistantStatusSchema, ConfirmMemoryProposalSchema, ConversationWithMessagesSchema,
  CreateConversationSchema, CreatedConversationSchema, CreateMemorySchema, MemoryItemSchema, MemoryListQuerySchema, MessagesSinceQuerySchema, MessagesSinceSchema, SendMessageSchema,
  SentTurnSchema, UpdateConversationSchema, UpdateMemorySchema, toDto,
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
