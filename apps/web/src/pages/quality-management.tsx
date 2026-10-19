import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from '../i18n';
import type { OpsApis } from '../components/standard-ops/use-standard-ops';
import type { EvidenceApi } from '../lib/evidence-api';
import type { FrameworkApi } from '../lib/framework-api';
import { useApi, useMe } from '../lib/me';
import { CyclesTab } from './cycles/cycles-tab';
import { MyWorkTab } from './cycles/my-work';
import { STATUS_LABEL } from './frameworks';
import { IqfRequirements } from './settings/iqf-requirements';

/**
 * The tabs of Quality Management. "Standards" is the institution's own framework in operation (TASK-086): the same tree as
 * Settings -> Internal Quality Framework, with the ⋯ menu Link evidence · Assign scope · Assign champion · Create cycle and without
 * the authoring, which stays in Settings. "Cycles" lists the cycles (TASK-080), each opening on its own page; "My work" is the stages
 * I own and the approvals waiting for me. Full width, no side panels. The tab is addressable as ?tab=standards|cycles|my-work.
 */
export const QM_TABS = [
  { id: 'standards', label: 'quality.tab.standards' },
  { id: 'cycles', label: 'quality.tab.cycles' },
  { id: 'my-work', label: 'quality.tab.myWork' },
] as const;
export type QmTab = (typeof QM_TABS)[number]['id'];

/** The institution's framework, its newest published version unless another is picked, in operation. */
function StandardsTab({ api, evidence, apis }: { api: FrameworkApi; evidence?: EvidenceApi; apis?: OpsApis }) {
  const { t } = useTranslation();
  const me = useMe(api);
  const [pick, setPick] = useState<string | null>(null);
  const { data, isError } = useQuery({ queryKey: ['quality-framework'], queryFn: () => api.qualityFramework() });
  const versions = data?.versions ?? [];
  const latestPublished = [...versions].reverse().find((v) => v.status === 'published');
  const current = versions.find((v) => v.id === pick) ?? latestPublished ?? versions[versions.length - 1];
  if (isError) return <p role="alert" className="text-sm text-red-700">{t('quality.loadFailed')}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (!data.framework || !current) return <p className="text-sm text-muted-foreground" data-testid="no-framework">{t('quality.noFramework')}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="min-w-0 font-medium break-words" dir="auto">{data.framework.name}</h2>
        {versions.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">{t('quality.version')}
            <select aria-label={t('quality.version')} className="max-w-full min-w-0 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground" value={current.id} onChange={(e) => setPick(e.target.value)}>
              {versions.map((v) => <option key={v.id} value={v.id}>{v.edition} · {STATUS_LABEL[v.status]}</option>)}
            </select>
          </label>
        )}
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">{t('quality.standardsIntro')}</p>
      <IqfRequirements key={current.id} api={api} version={{ ...current, internal: true }} me={me.data} operational {...(evidence ? { evidence } : {})} {...(apis ? { apis } : {})} />
    </div>
  );
}

/**
 * Quality Management: where the Internal Quality Framework is run day to day, as Accreditations is for the external accreditors.
 * Operations live here (assign scope and champions, link evidence, create cycles); the framework itself is written, versioned and
 * published in Settings -> Internal Quality Framework.
 */
export function QualityManagementPage({ api: apiProp, evidence, apis, tab: tabProp, onTab }: { api?: FrameworkApi; evidence?: EvidenceApi; apis?: OpsApis; tab?: QmTab; onTab?: (tab: QmTab) => void }) {
  const { t } = useTranslation();
  const api = useApi(apiProp);
  const me = useMe(api);
  const navigate = useNavigate();
  // The address (when the page is given one) decides the tab; on its own the page keeps it in state.
  const [own, setOwn] = useState<QmTab>('standards');
  const tab = tabProp ?? own;
  const setTab = (next: QmTab) => { setOwn(next); onTab?.(next); };
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold sm:text-2xl">{t('nav.quality')}</h1>
      <div role="tablist" aria-label={t('nav.quality')} className="flex flex-wrap gap-1 border-b border-border">
        {QM_TABS.map((x) => (
          <button key={x.id} role="tab" type="button" id={`qm-tab-${x.id}`} aria-selected={tab === x.id} aria-controls="qm-tabpanel" onClick={() => setTab(x.id)}
            className={`px-3 py-2 text-sm ${tab === x.id ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground'}`}>{t(x.label)}</button>
        ))}
      </div>
      <div role="tabpanel" id="qm-tabpanel" aria-labelledby={`qm-tab-${tab}`}>
        {tab === 'standards' && <StandardsTab api={api} {...(evidence ? { evidence } : {})} {...(apis ? { apis } : {})} />}
        {tab === 'cycles' && <CyclesTab me={me.data} meLoaded={me.isSuccess} {...(apis ? { apis } : {})} onOpen={(id) => { void navigate({ to: '/quality-management/cycles/$id', params: { id } }); }} />}
        {tab === 'my-work' && <MyWorkTab {...(apis ? { apis } : {})} />}
      </div>
    </div>
  );
}
