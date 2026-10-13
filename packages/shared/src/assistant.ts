// The in-app assistant (DEC-027, docs/assistant-plan.md): the shapes the API, the SPA and the worker share.
// Phase 1 is read-only answers plus memory. Phase 2 (bulk edits confirmed in the chat) adds more PART TYPES to the message
// format below and more TOOLS to the registry; nothing here has to change shape for it (see MessagePartSchema).
import { z } from 'zod';
import { ChangeProposalPartSchema } from './assistant-changes.js';

// ---- Limits (constants, shown in errors and in the UI) --------------------------------------------------------------
/** A person may start this many assistant turns per hour. */
export const ASSISTANT_TURNS_PER_HOUR = 30;
/** The longest message a person can send. */
export const ASSISTANT_MAX_MESSAGE_CHARS = 4000;
/** The longest memory text. */
export const MEMORY_MAX_CHARS = 1000;
/** How many memories are put in front of the model for one turn. */
export const MEMORY_TOP_K = 8;
/** The default cap on the tokens one assistant turn may spend (Settings -> AI -> Models -> Assistant overrides it). */
export const DEFAULT_ASSISTANT_TURN_TOKENS = 60_000;
/** The most model calls (tool rounds) in one turn. */
export const ASSISTANT_MAX_STEPS = 8;
/** The most selected items a context chip may carry. */
export const ASSISTANT_MAX_SELECTED = 50;

// ---- Context chips ---------------------------------------------------------------------------------------------------
/** Where the person is when they send a message. Validated against their read permissions on the server. */
export const AssistantContextSchema = z.object({
  versionId: z.uuid().optional(),
  engagementId: z.uuid().optional(),
  tab: z.string().trim().min(1).max(40).optional(),
  selectedIds: z.array(z.uuid()).max(ASSISTANT_MAX_SELECTED).optional(),
  route: z.string().trim().min(1).max(300).startsWith('/').optional(),
}).strict();
export type AssistantContext = z.infer<typeof AssistantContextSchema>;

// ---- Links the UI can render ------------------------------------------------------------------------------------------
export const AssistantLinkSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requirement'), id: z.uuid(), versionId: z.uuid(), code: z.string(), label: z.string() }),
  z.object({ kind: z.literal('source'), documentId: z.uuid(), versionId: z.uuid(), page: z.number().int().min(1), label: z.string() }),
  z.object({ kind: z.literal('version'), id: z.uuid(), label: z.string() }),
]);
export type AssistantLink = z.infer<typeof AssistantLinkSchema>;

// ---- Memory ----------------------------------------------------------------------------------------------------------
export const MEMORY_SCOPE_TYPES = ['institution', 'framework', 'version', 'engagement'] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];
export const MEMORY_VISIBILITIES = ['private', 'workspace'] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];
export const MEMORY_KINDS = ['preference', 'convention', 'fact', 'decision'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const MemoryScopeSchema = z.object({
  type: z.enum(MEMORY_SCOPE_TYPES),
  /** Null for the institution. */
  id: z.uuid().nullable(),
  /** A readable name ("IC 2025"), filled in when the scope is read. */
  label: z.string(),
});
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

const memoryText = z.string().trim().min(1, 'write something to remember').max(MEMORY_MAX_CHARS, `at most ${MEMORY_MAX_CHARS} characters`);
const scopeFields = {
  scopeType: z.enum(MEMORY_SCOPE_TYPES),
  scopeId: z.uuid().nullable().optional(),
};
const scopeRule = (v: { scopeType?: MemoryScopeType | undefined; scopeId?: string | null | undefined }, ctx: z.RefinementCtx) => {
  if (v.scopeType === undefined) return;
  if (v.scopeType === 'institution' && v.scopeId) ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'the institution scope has no id' });
  if (v.scopeType !== 'institution' && !v.scopeId) ctx.addIssue({ code: 'custom', path: ['scopeId'], message: 'choose what this memory is about' });
};

export const MemoryItemSchema = z.object({
  id: z.uuid(),
  scope: MemoryScopeSchema,
  visibility: z.enum(MEMORY_VISIBILITIES),
  kind: z.enum(MEMORY_KINDS),
  text: z.string(),
  createdBy: z.uuid().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pinned: z.boolean(),
  expiresAt: z.string().nullable(),
  archivedAt: z.string().nullable(),
  /** The person wrote it. */
  mine: z.boolean(),
  /** The person may edit or delete it. */
  canEdit: z.boolean(),
  sourceConversationId: z.uuid().nullable(),
});
export type MemoryItem = z.infer<typeof MemoryItemSchema>;

export const CreateMemorySchema = z.object({
  text: memoryText,
  ...scopeFields,
  visibility: z.enum(MEMORY_VISIBILITIES).default('private'),
  kind: z.enum(MEMORY_KINDS).default('fact'),
  pinned: z.boolean().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict().superRefine(scopeRule);
export type CreateMemory = z.input<typeof CreateMemorySchema>;

export const UpdateMemorySchema = z.object({
  text: memoryText.optional(),
  scopeType: z.enum(MEMORY_SCOPE_TYPES).optional(),
  scopeId: z.uuid().nullable().optional(),
  visibility: z.enum(MEMORY_VISIBILITIES).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
  pinned: z.boolean().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
  /** true removes it from use (it can be restored); a delete of an archived memory removes it for good. */
  archived: z.boolean().optional(),
}).strict().superRefine(scopeRule);
export type UpdateMemory = z.infer<typeof UpdateMemorySchema>;

export const MemoryListQuerySchema = z.object({
  scopeType: z.enum(MEMORY_SCOPE_TYPES).optional(),
  scopeId: z.uuid().optional(),
  /** `mine`: what the person wrote (private and shared); `shared`: workspace memory the person may read. Absent: both. */
  tab: z.enum(['mine', 'shared']).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});

/** What the person confirms on a "Remember this?" card. Absent fields keep what the assistant proposed. */
export const ConfirmMemoryProposalSchema = z.object({
  text: memoryText.optional(),
  scopeType: z.enum(MEMORY_SCOPE_TYPES).optional(),
  scopeId: z.uuid().nullable().optional(),
  visibility: z.enum(MEMORY_VISIBILITIES).optional(),
  kind: z.enum(MEMORY_KINDS).optional(),
}).strict().superRefine(scopeRule);
export type ConfirmMemoryProposal = z.infer<typeof ConfirmMemoryProposalSchema>;

// ---- Message parts ---------------------------------------------------------------------------------------------------
/**
 * What an assistant message is made of, in order. A closed set of typed parts, each with its own id (a memory card is
 * addressed by message id + part id). PHASE 2 slots in here: it adds a `change_proposal` part (what the assistant will do,
 * with the count and examples, and the one-time confirmation the button issues) and `change_applied`; the UI ignores a part
 * type it does not know (`parseParts` drops it), so an older client keeps working.
 */
export const TextPartSchema = z.object({ id: z.string(), type: z.literal('text'), text: z.string() });
export const ToolCallPartSchema = z.object({
  id: z.string(), type: z.literal('tool_call'), name: z.string(),
  /** A short plain-words summary of the arguments ("version IC 2025, search 'library'"), never raw model output. */
  summary: z.string(),
});
export const ToolResultPartSchema = z.object({
  id: z.string(), type: z.literal('tool_result'), callId: z.string(), name: z.string(),
  summary: z.string(), links: z.array(AssistantLinkSchema),
  /** The person may not see this (or it does not exist): the tool returned a refusal, not data. */
  refused: z.boolean().optional(),
});
export const MEMORY_PROPOSAL_STATUSES = ['pending', 'saved', 'declined'] as const;
export const MemoryProposalPartSchema = z.object({
  id: z.string(), type: z.literal('memory_proposal'),
  text: z.string(), scope: MemoryScopeSchema,
  visibility: z.enum(MEMORY_VISIBILITIES), kind: z.enum(MEMORY_KINDS),
  status: z.enum(MEMORY_PROPOSAL_STATUSES),
  /** Set once saved. */
  memoryId: z.uuid().nullable().optional(),
});
export const MessagePartSchema = z.discriminatedUnion('type', [TextPartSchema, ToolCallPartSchema, ToolResultPartSchema, MemoryProposalPartSchema, ChangeProposalPartSchema]);
export type MessagePart = z.infer<typeof MessagePartSchema>;
export type MemoryProposalPart = z.infer<typeof MemoryProposalPartSchema>;
export type ToolResultPart = z.infer<typeof ToolResultPartSchema>;

/** Keeps the parts this version understands and drops the rest (a newer server may send more part types). */
export function parseParts(raw: unknown): MessagePart[] {
  if (!Array.isArray(raw)) return [];
  const out: MessagePart[] = [];
  for (const p of raw) {
    const r = MessagePartSchema.safeParse(p);
    if (r.success) out.push(r.data);
  }
  return out;
}

// ---- Conversations and messages --------------------------------------------------------------------------------------
export const ASSISTANT_MESSAGE_ROLES = ['user', 'assistant', 'system_note'] as const;
export const ASSISTANT_MESSAGE_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type AssistantMessageStatus = (typeof ASSISTANT_MESSAGE_STATUSES)[number];

export const AssistantUsageSchema = z.object({
  inputTokens: z.number().int(), outputTokens: z.number().int(), costUsd: z.number().nullable(), calls: z.number().int(), model: z.string().nullable(),
});
export type AssistantUsage = z.infer<typeof AssistantUsageSchema>;

export const AssistantMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: z.enum(ASSISTANT_MESSAGE_ROLES),
  parts: z.array(MessagePartSchema),
  /** For assistant turns; null for the person's messages. */
  status: z.enum(ASSISTANT_MESSAGE_STATUSES).nullable(),
  error: z.string().nullable(),
  usage: AssistantUsageSchema.nullable(),
  /** The context chips sent with a person's message. */
  context: AssistantContextSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const AssistantConversationSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  context: AssistantContextSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type AssistantConversation = z.infer<typeof AssistantConversationSchema>;

export const ConversationWithMessagesSchema = AssistantConversationSchema.extend({ messages: z.array(AssistantMessageSchema) });

export const CreateConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  /** A first message, sent at once. */
  text: z.string().trim().min(1).max(ASSISTANT_MAX_MESSAGE_CHARS).optional(),
  context: AssistantContextSchema.optional(),
}).strict();
export const UpdateConversationSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
export const SendMessageSchema = z.object({
  text: z.string().trim().min(1).max(ASSISTANT_MAX_MESSAGE_CHARS),
  context: AssistantContextSchema.optional(),
}).strict();
export const SentTurnSchema = z.object({
  conversation: AssistantConversationSchema,
  userMessage: AssistantMessageSchema,
  assistantMessage: AssistantMessageSchema,
});
/** A new conversation, with its first turn when a first message came with it. */
export const CreatedConversationSchema = z.object({
  conversation: AssistantConversationSchema,
  userMessage: AssistantMessageSchema.nullable(),
  assistantMessage: AssistantMessageSchema.nullable(),
});
export const MessagesSinceQuerySchema = z.object({ after: z.iso.datetime().optional() });
export const MessagesSinceSchema = z.object({ messages: z.array(AssistantMessageSchema), cursor: z.string().nullable() });

/** Whether the assistant can be used now, and if not why (in plain words, with where to fix it). */
export const AssistantStatusSchema = z.object({
  available: z.boolean(),
  reason: z.enum(['ai_off', 'assistant_off', 'not_configured']).nullable(),
  message: z.string().nullable(),
  turnsPerHour: z.number().int(),
});
export type AssistantStatus = z.infer<typeof AssistantStatusSchema>;

/** The audit view of someone else's conversation (administrators with ai:manage; every read is recorded). */
export const AssistantAuditListSchema = z.array(AssistantConversationSchema.extend({ userId: z.uuid(), userName: z.string().nullable() }));
