import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ASSISTANT_MAX_MESSAGE_CHARS, type AssistantConversation, type AssistantLink, type AssistantMessage, type ChangeProposalPart, type MemoryProposalPart } from '@ams/shared';
import { Button } from '../ui/button';
import { useTranslation } from '../../i18n';
import { formatDate } from '../../lib/intl';
import { confirmDialog } from '../confirm-dialog';
import { ApiError } from '../../lib/framework-api';
import type { AssistantApi } from '../../lib/assistant-api';
import { chipsFor, contextFor, navFor, useScreen, type ChipId } from '../../lib/assistant-screen';
import { onUndone } from '../../lib/undo';
import { MessageView } from './message-view';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const iconButton = 'flex size-10 shrink-0 items-center justify-center rounded-md text-lg leading-none hover:bg-muted';

/** Where a link in the chat leads when the current screen cannot open it in place. The router decides how to get there. */
export type AssistantTarget =
  | { to: '/settings/versions/$versionId'; params: { versionId: string }; search?: { req?: string; doc?: string; page?: number } }
  | { to: '/settings/assistant-memory' }
  | { to: '/settings/ai' };

/** The example questions offered on an empty chat (the English wording is also what a person gets when they pick one). */
const useExamples = () => {
  const { t } = useTranslation();
  return [t('assistant.example1'), t('assistant.example2'), t('assistant.example3'), t('assistant.example4')];
};

const mergeMessages = (current: AssistantMessage[], incoming: AssistantMessage[]): AssistantMessage[] => {
  const byId = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.role === 'user' ? -1 : 1));
};
const isRunning = (m: AssistantMessage) => m.role === 'assistant' && (m.status === 'queued' || m.status === 'running');
const dateOf = (iso: string) => formatDate(iso, { day: 'numeric', month: 'short' });

/**
 * The assistant: a drawer beside the page on wide screens, a full-screen sheet on phones. It keeps the person's conversations
 * (new chat, history, delete), shows the context chips that go with each question, follows a running turn by polling every
 * second, and shows the assistant's steps, answer and "Remember this?" cards.
 */
export function AssistantPanel({ api, onClose, modal, pollMs = 1000, onNavigate, canManageAi }: {
  api: AssistantApi; onClose: () => void;
  /** Full-screen sheet (focus is kept inside, the page behind is still); false: a drawer the page can be used beside. */
  modal: boolean; pollMs?: number; onNavigate: (to: AssistantTarget) => void; canManageAi: boolean;
}) {
  const { t } = useTranslation();
  const examples = useExamples();
  const qc = useQueryClient();
  const screen = useScreen();
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [conversation, setConversation] = useState<AssistantConversation | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<ReadonlySet<ChipId>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const cursor = useRef<string | null>(null);

  const status = useQuery({ queryKey: ['assistant', 'status'], queryFn: () => api.status(), staleTime: 10_000 });
  const history = useQuery({ queryKey: ['assistant', 'conversations'], queryFn: () => api.conversations(), enabled: view === 'history' });
  const available = status.data?.available === true;
  const running = messages.some(isRunning);

  // Chips: what the screen published, minus what the person removed; removed ones come back when the screen changes.
  const where = `${screen.versionId ?? ''}|${screen.engagementId ?? ''}|${screen.route ?? ''}`;
  useEffect(() => { setRemoved(new Set()); }, [where]);
  const chips = useMemo(() => chipsFor(screen, removed), [screen, removed]);
  const removeChip = (id: ChipId) => setRemoved((r) => new Set([...r, id, ...(id === 'version' ? (['tab', 'selection'] as ChipId[]) : [])]));

  // ---- Following a running turn ----
  const convId = conversation?.id ?? null;
  useEffect(() => {
    if (!convId || !running) return undefined;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await api.since(convId, cursor.current);
        if (stopped) return;
        if (r.cursor) cursor.current = r.cursor;
        if (r.messages.length) setMessages((cur) => mergeMessages(cur, r.messages));
      } catch { /* the next tick tries again */ }
    };
    const timer = setInterval(() => { void tick(); }, pollMs);
    return () => { stopped = true; clearInterval(timer); };
  }, [api, convId, running, pollMs]);
  // When a turn ends, the history list is out of date (a new title, a newer time).
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running) void qc.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
    wasRunning.current = running;
  }, [running, qc]);

  // ---- Keeping the newest message in view and in the live region ----
  useEffect(() => { const el = list.current?.parentElement; if (el) el.scrollTop = el.scrollHeight; }, [messages, view]);
  // The composer takes focus when a turn ends, but never from something the person is using (a "Remember this?" card they are editing).
  useEffect(() => {
    if (view !== 'chat' || !available || running) return;
    const a = document.activeElement;
    if (!a || a === document.body || a === input.current) input.current?.focus();
  }, [view, available, running, convId]);

  // ---- Escape closes; on a phone Tab stays inside ----
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const el = root.current;
      if (!el) return;
      if (e.key === 'Escape') {
        // A question dialog above the panel answers Escape itself (it stops the event first).
        if (!modal && !el.contains(document.activeElement)) return;
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !modal) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0]; const last = items[items.length - 1];
      if (!first || !last) return;
      const topmost = document.querySelectorAll('[data-dialog-shell]').length === 0;
      if (!topmost) return;
      if (!el.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    if (modal) document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [modal, onClose]);

  // ---- Actions ----
  const reset = () => { setConversation(null); setMessages([]); cursor.current = null; setError(null); setDraft(''); setView('chat'); setRenaming(null); };
  const open = async (id: string) => {
    setError(null);
    try {
      const c = await api.conversation(id);
      const { messages: ms, ...rest } = c;
      setConversation(rest); setMessages(ms); cursor.current = ms.reduce((n, m) => (m.updatedAt > n ? m.updatedAt : n), ''); if (!cursor.current) cursor.current = null;
      setView('chat');
    } catch (e) { setError(e instanceof ApiError ? e.message : t('assistant.openFailed')); }
  };
  const send = useCallback(async (text: string, context: ReturnType<typeof contextFor>) => {
    setSending(true); setError(null);
    try {
      if (!convId) {
        const r = await api.createConversation({ text, ...(context ? { context } : {}) });
        setConversation(r.conversation);
        setMessages([r.userMessage, r.assistantMessage].filter((m): m is AssistantMessage => !!m));
        cursor.current = r.assistantMessage?.updatedAt ?? null;
      } else {
        const r = await api.send(convId, { text, ...(context ? { context } : {}) });
        setConversation(r.conversation);
        setMessages((cur) => mergeMessages(cur, [r.userMessage, r.assistantMessage]));
      }
      void qc.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('assistant.sendFailed'));
      return false;
    } finally { setSending(false); }
  }, [api, convId, qc]);
  const submit = async () => {
    const text = draft.trim();
    if (!text || running || sending || !available) return;
    if (await send(text, contextFor(screen, chips))) setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  };
  const stop = async () => {
    const m = [...messages].reverse().find(isRunning);
    if (!m) return;
    try { const r = await api.cancel(m.id); setMessages((cur) => mergeMessages(cur, [r])); } catch (e) { setError(e instanceof ApiError ? e.message : t('assistant.stopFailed')); }
  };
  const retry = (failed: AssistantMessage) => {
    const i = messages.findIndex((m) => m.id === failed.id);
    const question = [...messages.slice(0, i)].reverse().find((m) => m.role === 'user');
    const text = question?.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') ?? '';
    if (text) void send(text, question?.context ?? undefined);
  };
  const resolved = (messageId: string, partId: string, patch: Partial<MemoryProposalPart>) =>
    setMessages((cur) => cur.map((m) => (m.id === messageId ? { ...m, parts: m.parts.map((p) => (p.id === partId && p.type === 'memory_proposal' ? { ...p, ...patch } : p)) } : m)));
  const changed = (messageId: string, partId: string, next: ChangeProposalPart) =>
    setMessages((cur) => cur.map((m) => (m.id === messageId ? { ...m, parts: m.parts.map((p) => (p.id === partId && p.type === 'change_proposal' ? next : p)) } : m)));
  // "Change it": the card stays; the person says what to change and the assistant proposes again (the old card is then replaced).
  const changeIt = () => { setDraft((d) => d || t('assistant.changeIt')); input.current?.focus(); };
  // After a change was applied, undone or redone (here or from the toast): the data under the screens moved, and so did the cards.
  const refreshChanged = useCallback(async () => {
    void qc.invalidateQueries();
    if (!convId) return;
    try { const r = await api.since(convId, null); setMessages((cur) => mergeMessages(cur, r.messages)); } catch { /* the next refresh tries again */ }
  }, [api, convId, qc]);
  useEffect(() => onUndone(() => { void refreshChanged(); }), [refreshChanged]);
  const openLink = (l: AssistantLink) => {
    const nav = l.kind === 'version' ? undefined : navFor(l.versionId);
    if (l.kind === 'requirement') { if (nav) nav.showRequirement(l.id); else onNavigate({ to: '/settings/versions/$versionId', params: { versionId: l.versionId }, search: { req: l.id } }); }
    else if (l.kind === 'source') { if (nav) nav.showPage(l.documentId, l.page); else onNavigate({ to: '/settings/versions/$versionId', params: { versionId: l.versionId }, search: { doc: l.documentId, page: l.page } }); }
    else onNavigate({ to: '/settings/versions/$versionId', params: { versionId: l.id } });
    // A full-screen sheet covers what the link opens.
    if (modal) onClose();
  };
  const deleteChat = async (c: AssistantConversation) => {
    const ok = await confirmDialog({
      title: t('assistant.deleteChat.title'), message: t('assistant.deleteChat.message', { title: c.title }), confirmLabel: t('common.delete'), tone: 'danger',
    });
    if (!ok) return;
    try {
      await api.deleteConversation(c.id);
      if (c.id === convId) reset();
      await qc.invalidateQueries({ queryKey: ['assistant', 'conversations'] });
    } catch (e) { setError(e instanceof ApiError ? e.message : t('assistant.deleteFailed')); }
  };
  const rename = async (title: string) => {
    if (!conversation) return;
    setRenaming(null);
    if (!title.trim() || title.trim() === conversation.title) return;
    try { setConversation(await api.renameConversation(conversation.id, title.trim())); void qc.invalidateQueries({ queryKey: ['assistant', 'conversations'] }); } catch (e) { setError(e instanceof ApiError ? e.message : t('assistant.renameFailed')); }
  };

  const unavailable = status.data && !status.data.available ? status.data : null;
  return (
    <aside
      ref={root} role="dialog" aria-modal={modal} aria-label={t('assistant.title')} data-testid="assistant-panel"
      className="print:hidden fixed inset-0 z-50 flex flex-col bg-background lg:inset-y-0 lg:start-auto lg:end-0 lg:z-40 lg:w-[26rem] lg:border-s lg:border-border lg:shadow-xl"
    >
      <header className="flex items-center gap-1 border-b border-border px-3 py-2">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold" dir="auto">
          {view === 'history' ? t('assistant.history') : t('assistant.title')}
        </h2>
        <Button type="button" variant="outline" onClick={reset} aria-label={t('assistant.newChat')}>{t('assistant.newChat')}</Button>
        <button type="button" className={iconButton} aria-label={view === 'history' ? t('assistant.backToChat') : t('assistant.chatHistory')} aria-pressed={view === 'history'} onClick={() => setView(view === 'history' ? 'chat' : 'history')}>
          <span aria-hidden="true" className={view === 'history' ? 'mirror-rtl' : ''}>{view === 'history' ? '←' : '☰'}</span>
        </button>
        <button type="button" className={iconButton} aria-label={t('assistant.close')} onClick={onClose}><span aria-hidden="true">✕</span></button>
      </header>

      {view === 'history' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {history.isLoading && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
          {history.data && history.data.length === 0 && <p className="text-sm text-muted-foreground">{t('assistant.noChats')}</p>}
          <ul className="space-y-1" aria-label={t('assistant.history')}>
            {(history.data ?? []).map((c) => (
              <li key={c.id} className="flex items-center gap-1 rounded-md border border-border">
                <button type="button" onClick={() => void open(c.id)} className="min-w-0 flex-1 px-3 py-2 text-start text-sm hover:bg-muted" aria-current={c.id === convId ? 'true' : undefined}>
                  <span className="block truncate" dir="auto">{c.title}</span>
                  <span className="block text-xs text-muted-foreground">{dateOf(c.updatedAt)}</span>
                </button>
                <button type="button" className={iconButton} aria-label={t('assistant.deleteChat.label', { title: c.title })} onClick={() => void deleteChat(c)}><span aria-hidden="true">🗑</span></button>
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
        </div>
      ) : (
        <>
          {conversation && (
            <div className="flex items-center gap-1 border-b border-border px-3 py-1 text-sm">
              {renaming !== null ? (
                <input aria-label={t('assistant.chatTitle')} autoFocus value={renaming} maxLength={120} onChange={(e) => setRenaming(e.target.value)} dir="auto"
                  onBlur={() => void rename(renaming)} onKeyDown={(e) => { if (e.key === 'Enter') void rename(renaming); if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }}
                  className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2" />
              ) : (
                <>
                  <p className="min-w-0 flex-1 truncate text-muted-foreground" dir="auto" data-testid="chat-title">{conversation.title}</p>
                  <button type="button" className="flex size-8 items-center justify-center rounded-md hover:bg-muted" aria-label={t('assistant.rename')} onClick={() => setRenaming(conversation.title)}><span aria-hidden="true">✎</span></button>
                </>
              )}
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {unavailable && (
              <div role="status" className="mb-3 space-y-2 rounded-md border border-border bg-muted/50 p-3 text-sm" data-testid="assistant-unavailable">
                <p className="font-medium">{unavailable.reason === 'assistant_off' ? t('assistant.off') : unavailable.reason === 'ai_off' ? t('assistant.aiOff') : t('assistant.notSetUp')}</p>
                <p dir="auto">{unavailable.message}</p>
                {canManageAi
                  ? <button type="button" className="underline" onClick={() => { onNavigate({ to: '/settings/ai' }); if (modal) onClose(); }}>{t('assistant.openAiSettings')}</button>
                  : <p className="text-muted-foreground">{t('assistant.adminCanSwitchOn')}</p>}
              </div>
            )}
            {status.isError && <p role="alert" className="mb-3 text-sm text-red-700">{t('assistant.statusFailed')}</p>}
            {messages.length === 0 && !unavailable && (
              <div className="space-y-3 text-sm" data-testid="assistant-empty">
                <p dir="auto">{t('assistant.intro')}</p>
                <ul className="space-y-1">
                  {examples.map((e) => <li key={e}><button type="button" className="w-full rounded-md border border-border px-3 py-2 text-start hover:bg-muted" onClick={() => { setDraft(e); input.current?.focus(); }}>{e}</button></li>)}
                </ul>
              </div>
            )}
            <ol ref={list} role="log" aria-live="polite" aria-relevant="additions text" aria-label={t('assistant.conversation')} className="space-y-3">
              {messages.map((m) => (
                <MessageView key={m.id} message={m} api={api} screen={screen} onOpenLink={openLink} onRetry={retry} onResolved={resolved}
                  onChangePart={changed} onChangeIt={changeIt} onChanged={() => { void refreshChanged(); }}
                  onOpenMemory={() => { onNavigate({ to: '/settings/assistant-memory' }); if (modal) onClose(); }} />
              ))}
            </ol>
          </div>
          <div className="space-y-2 border-t border-border p-3">
            {chips.length > 0 && (
              <ul className="flex flex-wrap gap-1" aria-label={t('assistant.context')}>
                {chips.map((c) => (
                  <li key={c.id} className="flex items-center gap-1 rounded-full border border-border bg-muted ps-2.5 text-xs">
                    <span dir="auto" className="py-0.5">{c.label}</span>
                    <button type="button" aria-label={t('assistant.removeChip', { label: c.label })} onClick={() => removeChip(c.id)} className="flex size-7 items-center justify-center rounded-full hover:bg-background"><span aria-hidden="true">✕</span></button>
                  </li>
                ))}
              </ul>
            )}
            {error && <p role="alert" className="text-sm text-red-700" data-testid="assistant-send-error">{error}</p>}
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className="sr-only">{t('assistant.ask')}</span>
                <textarea ref={input} aria-label={t('assistant.ask')} dir="auto" rows={2} value={draft} maxLength={ASSISTANT_MAX_MESSAGE_CHARS} disabled={running || sending || !available}
                  placeholder={available ? t('assistant.placeholder') : t('assistant.unavailable')} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown}
                  className="max-h-40 min-h-11 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm disabled:opacity-60" />
              </label>
              {running
                ? <Button type="button" variant="outline" onClick={() => void stop()}>{t('assistant.stop')}</Button>
                : <Button type="button" onClick={() => void submit()} disabled={!draft.trim() || sending || !available}>{t('assistant.send')}</Button>}
            </div>
            <p className="text-[11px] text-muted-foreground">{t('assistant.keys')}</p>
          </div>
        </>
      )}
    </aside>
  );
}
