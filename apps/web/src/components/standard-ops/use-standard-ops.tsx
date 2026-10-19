// The three operations every standard's ⋯ menu shares (TASK-086): Assign scope, Assign champion, Create cycle. The menu is
// Link evidence · Assign scope · Assign champion · Create cycle, then the authoring items; Link evidence and the authoring items
// stay with each page (they differ between the institution's own framework and an external standard), this hook gives the three
// in the middle and the dialogs they open. Permissions: framework:write to assign, cycle:manage to create a cycle.
import { useState, type ReactNode } from 'react';
import type { Me } from '@ams/shared';
import { useTranslation } from '../../i18n';
import type { CyclesApi } from '../../lib/cycles-api';
import { can } from '../../lib/me';
import type { ScopeApi } from '../../lib/scope-api';
import type { SettingsApi } from '../../lib/settings-api';
import type { Requirement, Version } from '../../lib/framework-api';
import { ChampionDialog } from './champion-dialog';
import { CreateCycleDialog } from './create-cycle-dialog';
import { ScopeDialog, type OpsTarget } from './scope-dialog';
import type { NodeAssignment } from '@ams/shared';

export interface OpsApis { scope?: ScopeApi; cycles?: CyclesApi; settings?: SettingsApi }
export type MenuItem = { label: string; onSelect: () => void };

/**
 * `assignmentOf(code)` reads the page's one batched requirement-context (undefined until it has loaded). `tagOf` is the label the
 * page shows for a requirement ("Standard 4.2", "CFR 1.1"). The returned `items(r)` are in menu order and already filtered by
 * what the person may do; `dialogs` goes anywhere in the page.
 */
export function useStandardOps({ me, version, assignmentOf, tagOf, apis = {} }: {
  me: Me | undefined; version: Version; assignmentOf: (code: string) => NodeAssignment | undefined; tagOf: (r: Requirement) => string; apis?: OpsApis;
}): { items: (r: Requirement) => MenuItem[]; dialogs: ReactNode } {
  const { t } = useTranslation();
  const [open, setOpen] = useState<{ kind: 'scope' | 'champion' | 'cycle'; r: Requirement } | null>(null);
  const internal = version.internal === true;
  const items = (r: Requirement): MenuItem[] => [
    ...(can(me, 'framework:write') ? [
      { label: t('ops.menu.scope'), onSelect: () => setOpen({ kind: 'scope', r }) },
      { label: t('ops.menu.champion'), onSelect: () => setOpen({ kind: 'champion', r }) },
    ] : []),
    ...(can(me, 'cycle:manage') ? [{ label: t('ops.menu.cycle'), onSelect: () => setOpen({ kind: 'cycle', r }) }] : []),
  ];
  let dialogs: ReactNode = null;
  if (open) {
    const r = open.r;
    const target: OpsTarget = { frameworkId: version.frameworkId, versionId: version.id, code: r.code, title: r.title, label: tagOf(r), internal };
    const close = () => setOpen(null);
    const assignment = assignmentOf(r.code);
    dialogs = open.kind === 'scope' ? <ScopeDialog target={target} assignment={assignment} {...(apis.scope ? { api: apis.scope } : {})} onClose={close} />
      : open.kind === 'champion' ? <ChampionDialog target={target} assignment={assignment} {...(apis.scope ? { api: apis.scope } : {})} {...(apis.settings ? { settings: apis.settings } : {})} onClose={close} />
        : <CreateCycleDialog target={{ ...target, anchorId: r.id }} me={me} assignment={assignment} {...(apis.cycles ? { api: apis.cycles } : {})} {...(apis.scope ? { scope: apis.scope } : {})} {...(apis.settings ? { settings: apis.settings } : {})} onClose={close} />;
  }
  return { items, dialogs };
}
