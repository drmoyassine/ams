// In-app notifications (TASK-088): something a person proposed was decided. Email comes with SMTP (TASK-061).
import { z } from 'zod';
import { EvidenceLinkSchema } from './evidence.js';

export const NOTIFICATION_KINDS = ['link_rejected', 'link_approved'] as const;

export const NotificationSchema = z.object({
  id: z.string(), kind: z.enum(NOTIFICATION_KINDS), title: z.string(), body: z.string(),
  refKind: z.string().nullable(), refId: z.string().nullable(), readAt: z.string().nullable(), createdAt: z.string(),
  /** For a link notice: the link as it is now (null when it was removed or the person can no longer see it). A rejected one can be resubmitted. */
  link: EvidenceLinkSchema.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;
