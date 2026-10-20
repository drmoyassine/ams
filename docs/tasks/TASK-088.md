---
id: TASK-088
title: 'Evidence links: reviewers approve their own, rejections give a reason, proposers are notified'
description: >-
  A link made by someone who may review it is approved at once; rejecting a link needs a reason; the proposer is told in the
  app (a Notifications section in My work, counted in the menu) and can resubmit a rejected link or dismiss the notice
status: completed
priority: P1
last_updated: '2026-10-20'
generated:
  by: agent/claude-code
  at: '2026-10-20T14:00:00.000Z'
roadmap_item:
  id: ROADMAP-013
  name: 'Quality Management: cycles and reporting'
  url: /ROADMAP.md#ROADMAP-013
depends_on:
  - id: TASK-086
    name: 'IQF in operation: Link evidence, Assign scope, Assign champion, Create cycle'
    url: /TASKS.md#TASK-086
  - id: TASK-087
    name: 'Simplify cycles: evidence collection, one owner'
    url: /TASKS.md#TASK-087
related_decisions:
  - id: DEC-006
    name: Authority classification with deterministic quote verification; AI proposes, humans publish
    url: /DECISIONS.md#DEC-006
modified:
  by: agent/claude-code
  at: '2026-10-20T14:00:00.000Z'
---
# TASK-088 — Evidence links: reviewers approve their own, rejections give a reason, proposers are notified

Owner request 2026-10-20.

Built (2026-10-20), migration `0063_notifications.sql` (journal idx 63):
- **Auto-approve for reviewers.** Every creation path of a link made by a person (`linkToRequirement` / `linkToInternal`, so IQF items and external requirements, and `linkToEngagementRequirement`) goes through `createLink`: if the creator may review that link, by the same check `assertMayReview` uses (`evidence:review` for a library link, `engagement:review` on the engagement for an engagement link), it is created `approved` with `reviewed_by` = the creator, `reviewed_at` = now and no comment; otherwise `proposed`. The insert is audited by the table's audit trigger. Answers to evidence requests keep their own flow (`newLink`, always `proposed`); the AI never approves (`assertHuman` stays first). The server's Undo toast says "Linked and approved X to Y" or "Proposed X for Y: a reviewer approves it" (engagement links now report an Undo too), and the Link evidence dialog says which will happen (`mayReview`).
- **Rejection needs a reason.** `ReviewLinkSchema` requires `comment` when the decision is `rejected` (optional for `approved`). The Reject action in every list of links (`EvidenceLinkList`: IQF items, external requirements, the requirement workspace, the evidence card, the version requirements tab) opens `RejectLinkDialog` with a required "Why is it rejected?" textarea (`dir="auto"`). A rejected link shows "Rejected by X on date: reason" everywhere (`EvidenceLink` gains `reviewedAt` and `linkedBy`).
- **Notifications.** New table `notification` (kind `link_rejected` | `link_approved`, user, title, body, `ref_kind` / `ref_id`, `read_at`); tenant and own-rows row-level security (a person selects, updates and deletes only their own rows, administrators included; any signed-in action of the institution may insert one for a colleague of the same institution, checked by a trigger; only `read_at` can change); stamp and audit triggers; the worker has SELECT only. Core `notifications/`: `createNotification` (internal, no route; not read back because the recipient is usually someone else), `listMyNotifications` (unread first; a link notice carries the link as it is now), `markNotificationRead`, `dismissNotification`. `reviewLink` notifies `link.linkedBy` of a rejection (with the reason) or of an approval by someone else, never the person who decided. `resubmitLink(id, {rationale})`: only the proposer, only while rejected, back to `proposed` with the new rationale and the review fields cleared (the audit log keeps the rejection and its reason); it removes the proposer's notices about that link. API (all `requires('evidence:read')`, the service checks the rest): `GET /api/notifications`, `POST /api/notifications/{id}/read`, `DELETE /api/notifications/{id}`, `POST /api/evidence-links/{id}/resubmit`.
- **My work.** A Notifications section first (unread first, "New" chip): "Your link of X to Y was rejected: reason" with Resubmit (opens `ResubmitLinkDialog`, prefilled with the old justification), Mark as read and Dismiss. The top-menu count of My work includes unread notifications (`MyWorkLink`).
- Email is not sent: the `notify` job stays a stub until SMTP (TASK-061); the worker can already read the table.
- Tests: core `evidence/link-review.test.ts` (8) and the updated `evidence.test.ts`; db `notifications.test.ts` (5); api `evidence.test.ts`; web `link-review-ui.test.tsx`; responsive states in e2e/responsive.mjs (reject dialog, My work notifications).

Not done: email of the same notices (TASK-061), notices for other events (requests, cycles), a "mark all read" action.
