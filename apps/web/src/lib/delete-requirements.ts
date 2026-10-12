import type { ConfirmOptions } from '../components/confirm-dialog';
import type { FrameworkApi } from './framework-api';

/**
 * Asks the question for deleting requirements with what goes with them (the words come from the server, so every screen says
 * it the same way), then deletes them in one action. Resolves true when they were deleted. The Undo toast comes from the
 * server's X-Undo header (see lib/undo.ts).
 */
export async function confirmAndDelete(
  api: Pick<FrameworkApi, 'previewDelete' | 'deleteMany'>, confirm: (o: ConfirmOptions) => Promise<boolean>, ids: string[], title: string,
): Promise<boolean> {
  const preview = await api.previewDelete(ids);
  const ok = await confirm({ title, message: preview.message, confirmLabel: 'Delete', tone: 'danger' });
  if (!ok) return false;
  await api.deleteMany(ids);
  return true;
}

/**
 * "Delete all standards in this version": one question with the counts (the same words everywhere), one action, one Trash
 * group and one Undo. Resolves 'empty' when there was nothing to delete, true when deleted, false when the person said no.
 */
export async function confirmAndDeleteAll(
  api: Pick<FrameworkApi, 'requirements' | 'previewDelete' | 'deleteAllRequirements'>, confirm: (o: ConfirmOptions) => Promise<boolean>, versionId: string, place: string,
): Promise<boolean | 'empty'> {
  const rows = await api.requirements(versionId);
  if (!rows.length) return 'empty';
  const p = await api.previewDelete(rows.filter((r) => !r.parentId).map((r) => r.id));
  const total = (p.counts.items ?? 0) + (p.counts.subItems ?? 0);
  const ok = await confirm({
    title: 'Delete all standards in this version?', tone: 'danger', confirmLabel: 'Delete all',
    message: `Delete all ${total} standard${total === 1 ? '' : 's'}${p.counts.notes ? ` and ${p.counts.notes} notes` : ''} in ${place}? You can restore them from the Trash for 30 days.`,
  });
  if (!ok) return false;
  await api.deleteAllRequirements(versionId);
  return true;
}
