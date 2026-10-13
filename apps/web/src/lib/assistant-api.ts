import type {
  AssistantContext, AssistantConversation, AssistantMessage, AssistantStatus, ChangeProposalPart, ConfirmMemoryProposal, CreateMemory, MemoryItem, MemoryScopeType, UpdateMemory, WrittenText,
} from '@ams/shared';
import { api as defaultApi, fetcherOf } from './api';
import { redoDescriptor, undoDescriptor } from './undo';
import { unwrap, type Api } from './framework-api';

export type ConversationWithMessages = AssistantConversation & { messages: AssistantMessage[] };
export interface SentTurn { conversation: AssistantConversation; userMessage: AssistantMessage | null; assistantMessage: AssistantMessage | null }
export interface ConfirmedChange { status: 'ready' | 'stale'; message: string | null; token: string | null; expiresAt: string | null; changeSetHash: string; part: ChangeProposalPart }
export interface AppliedChange { status: 'applied' | 'failed' | 'stale'; message: string; part: ChangeProposalPart }
export interface MemoryQuery { scopeType?: MemoryScopeType; scopeId?: string; tab?: 'mine' | 'shared'; includeArchived?: boolean }

/** The in-app assistant's calls (DEC-027), through the typed client. */
export function assistantApi(api: Api = defaultApi) {
  const a = api.api.assistant;
  return {
    status: () => a.status.$get().then((r) => unwrap<AssistantStatus>(r)),
    conversations: () => a.conversations.$get().then((r) => unwrap<AssistantConversation[]>(r)),
    conversation: (id: string) => a.conversations[':id'].$get({ param: { id } }).then((r) => unwrap<ConversationWithMessages>(r)),
    createConversation: (json: { text?: string; title?: string; context?: AssistantContext }) => a.conversations.$post({ json }).then((r) => unwrap<SentTurn>(r)),
    renameConversation: (id: string, title: string) => a.conversations[':id'].$patch({ param: { id }, json: { title } }).then((r) => unwrap<AssistantConversation>(r)),
    deleteConversation: (id: string) => a.conversations[':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),
    send: (id: string, json: { text: string; context?: AssistantContext }) => a.conversations[':id'].messages.$post({ param: { id }, json }).then((r) => unwrap<{ conversation: AssistantConversation; userMessage: AssistantMessage; assistantMessage: AssistantMessage }>(r)),
    since: (id: string, after?: string | null) =>
      a.conversations[':id'].messages.$get({ param: { id }, query: after ? { after } : {} }).then((r) => unwrap<{ messages: AssistantMessage[]; cursor: string | null }>(r)),
    cancel: (messageId: string) => a.messages[':id'].cancel.$post({ param: { id: messageId } }).then((r) => unwrap<AssistantMessage>(r)),
    confirmProposal: (messageId: string, partId: string, json: ConfirmMemoryProposal = {}) =>
      a['memory-proposals'][':messageId'][':partId'].confirm.$post({ param: { messageId, partId }, json }).then((r) => unwrap<MemoryItem>(r)),
    declineProposal: (messageId: string, partId: string) => a['memory-proposals'][':messageId'][':partId'].decline.$post({ param: { messageId, partId } }).then((r) => unwrap<void>(r)),
    // ---- Bulk edits confirmed in the chat (Phase 2). Do it = confirm (a one-time token) then apply with it. ----
    confirmChange: (messageId: string, partId: string) =>
      a['change-proposals'][':messageId'][':partId'].confirm.$post({ param: { messageId, partId } }).then((r) => unwrap<ConfirmedChange>(r)),
    applyChange: (messageId: string, partId: string, token: string) =>
      a['change-proposals'][':messageId'][':partId'].apply.$post({ param: { messageId, partId }, json: { token } }).then((r) => unwrap<AppliedChange>(r)),
    declineChange: (messageId: string, partId: string) =>
      a['change-proposals'][':messageId'][':partId'].decline.$post({ param: { messageId, partId } }).then((r) => unwrap<ChangeProposalPart>(r)),
    /** Undo / Redo of an applied change set: through the undo bus, so the toast, Ctrl+Z and Ctrl+Shift+Z follow. */
    undoChange: (changeSetId: string, label: string) => undoDescriptor(fetcherOf(api), { label, method: 'POST', path: `/api/assistant/changes/${changeSetId}/undo` }),
    redoChange: (changeSetId: string, label: string) => redoDescriptor(fetcherOf(api), { label, method: 'POST', path: `/api/assistant/changes/${changeSetId}/redo` }),
    // ---- Texts the assistant wrote (the "Written by the assistant" marker) ----
    writtenTexts: (versionId: string) => api.api['framework-versions'][':id']['assistant-texts'].$get({ param: { id: versionId } }).then((r) => unwrap<WrittenText[]>(r)),
    keepWritten: (id: string) => a['written-texts'][':id'].keep.$post({ param: { id } }).then((r) => unwrap<void>(r)),
    revertWritten: (id: string) => a['written-texts'][':id'].revert.$post({ param: { id } }).then((r) => unwrap<void>(r)),
    memory: (q: MemoryQuery = {}) =>
      a.memory.$get({ query: { ...(q.scopeType ? { scopeType: q.scopeType } : {}), ...(q.scopeId ? { scopeId: q.scopeId } : {}), ...(q.tab ? { tab: q.tab } : {}), ...(q.includeArchived ? { includeArchived: 'true' as const } : {}) } })
        .then((r) => unwrap<MemoryItem[]>(r)),
    createMemory: (json: CreateMemory) => a.memory.$post({ json }).then((r) => unwrap<MemoryItem>(r)),
    updateMemory: (id: string, json: UpdateMemory) => a.memory[':id'].$patch({ param: { id }, json }).then((r) => unwrap<MemoryItem>(r)),
    deleteMemory: (id: string) => a.memory[':id'].$delete({ param: { id } }).then((r) => unwrap<{ purged: boolean }>(r)),
  };
}
export type AssistantApi = ReturnType<typeof assistantApi>;
export const defaultAssistantApi = assistantApi();
export const useAssistantApi = (override?: AssistantApi) => override ?? defaultAssistantApi;
