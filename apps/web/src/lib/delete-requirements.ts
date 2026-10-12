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
