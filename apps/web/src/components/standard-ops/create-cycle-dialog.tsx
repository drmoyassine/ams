import { useNavigate } from '@tanstack/react-router';
import type { Me, NodeAssignment } from '@ams/shared';
import type { CycleApis } from '../cycles/directory';
import { LaunchCycleDialog } from '../cycles/launch-cycle-dialog';
import type { OpsTarget } from './scope-dialog';

/**
 * Create cycle, from the ⋯ menu of a standard: the standard is the cycle's anchor. It is the same launch dialog as "New cycle" in
 * Quality Management (components/cycles/launch-cycle-dialog.tsx); only the anchor is fixed here, and a scope that is a single unit or
 * program starts the choice of who the cycle is about. The cycle is made as a draft; the dialog then shows who is responsible for
 * each stage, lets a person fix what the template's rules could not settle, and links to the cycle's own page.
 */
export function CreateCycleDialog({ target, me, assignment, apis, onClose }: {
  target: OpsTarget & { anchorId: string }; me: Me | undefined; assignment: NodeAssignment | undefined; apis?: CycleApis; onClose: () => void;
}) {
  const navigate = useNavigate();
  const only = (assignment?.scope.effective?.levels ?? []).flatMap((l) => (l.kind === 'org_unit' || l.kind === 'program') && !l.all && l.items.length === 1 ? [`${l.kind}:${l.items[0]!.id}`] : []);
  return (
    <LaunchCycleDialog
      anchor={{ kind: 'requirement', id: target.anchorId, label: target.label, title: target.title }}
      subject={only.length === 1 ? only[0]! : ''} me={me} {...(apis ? { apis } : {})} onClose={onClose}
      onOpen={(id) => { void navigate({ to: '/quality-management/cycles/$id', params: { id } }); }}
    />
  );
}
