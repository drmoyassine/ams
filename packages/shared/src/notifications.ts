// In-app notifications (TASK-088): something a person proposed was decided. Email comes with SMTP (TASK-061).
import { z } from 'zod';
import { EvidenceLinkSchema } from './evidence.js';

/** `collection_*`: an evidence collection run is due, late or failed (TASK-090). */
export const NOTIFICATION_KINDS = ['link_rejected', 'link_approved', 'collection_due', 'collection_late', 'collection_failed'] as const;

export const NotificationSchema = z.object({
  id: z.string(), kind: z.enum(NOTIFICATION_KINDS), title: z.string(), body: z.string(),
  refKind: z.string().nullable(), refId: z.string().nullable(), readAt: z.string().nullable(), createdAt: z.string(),
  /** For a link notice: the link as it is now (null when it was removed or the person can no longer see it). A rejected one can be resubmitted. */
  link: EvidenceLinkSchema.nullable(),
  /** For a `collection_*` notice (TASK-090): the run it is about, so the screen can open its evidence item; null when the run is not visible any more. */
  run: z.object({ id: z.string(), evidenceItemId: z.string(), evidenceTitle: z.string(), periodLabel: z.string(), status: z.string() }).nullable().optional(),
});
export type Notification = z.infer<typeof NotificationSchema>;
