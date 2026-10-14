import { useEffect, useRef, useState } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { routeLabelOf, usePublishScreen } from '../../lib/assistant-screen';
import { useAssistantApi, type AssistantApi } from '../../lib/assistant-api';
import { useTranslation } from '../../i18n';
import { AssistantPanel, type AssistantTarget } from './panel';

const WIDE = '(min-width: 64rem)';
const useWideScreen = (): boolean => {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches;
  const [wide, setWide] = useState(read);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const m = window.matchMedia(WIDE);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener?.('change', on);
    return () => m.removeEventListener?.('change', on);
  }, []);
  return wide;
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** What the address alone says about where the person is (the route-level chips); pages add the details (names, tab, selection). */
function useRouteContext() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const label = routeLabelOf(pathname);
  const version = new RegExp(`^/settings/versions/(${UUID})`, 'i').exec(pathname)?.[1];
  const engagement = new RegExp(`^/engagements/(${UUID})`, 'i').exec(pathname)?.[1];
  usePublishScreen('route', { route: pathname, ...(label ? { routeLabel: label } : {}), ...(version ? { versionId: version } : {}), ...(engagement ? { engagementId: engagement } : {}) });
}

/**
 * The bubble in the corner of every signed-in screen, and the panel it opens (DEC-027). Not printed; above any bottom bar on a
 * phone; at least 44 px to tap. On wide screens the page makes room beside the drawer instead of sitting under it.
 */
export function AssistantLauncher({ api: override, canManageAi, pollMs }: { api?: AssistantApi; canManageAi: boolean; pollMs?: number }) {
  const { t } = useTranslation();
  const api = useAssistantApi(override);
  const navigate = useNavigate();
  const wide = useWideScreen();
  const [open, setOpen] = useState(false);
  const bubble = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useRouteContext();

  useEffect(() => {
    document.documentElement.classList.toggle('assistant-open', open && wide);
    return () => document.documentElement.classList.remove('assistant-open');
  }, [open, wide]);
  useEffect(() => {
    if (wasOpen.current && !open) bubble.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const go = (t: AssistantTarget) => {
    // The router's own types know the version page's search keys; this panel only ever sends valid ones.
    void (navigate as unknown as (o: unknown) => Promise<void>)(t);
  };
  if (open) return <AssistantPanel api={api} modal={!wide} onClose={() => setOpen(false)} onNavigate={go} canManageAi={canManageAi} {...(pollMs ? { pollMs } : {})} />;
  return (
    <button ref={bubble} type="button" onClick={() => setOpen(true)} aria-label={t('assistant.title')} aria-haspopup="dialog" data-testid="assistant-bubble"
      className="print:hidden fixed bottom-20 end-4 z-30 flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground shadow-lg hover:opacity-90 lg:bottom-6 lg:end-6">
      <span aria-hidden="true">✦</span>
      <span>{t('assistant.title')}</span>
    </button>
  );
}
