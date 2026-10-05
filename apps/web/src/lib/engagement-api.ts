import type { z } from 'zod';
import type {
  Me, AddMember, AddMilestone, ApplyTemplateUpdate, AssignRequirements, CreateEngagement, CreateEngagementResultSchema, EngagementDetail, Engagement, Handover,
  Member, Milestone, ProgramSchema, ReorderMilestones, RequirementList, SetApplicability, TemplateUpdate, UpdateEngagement, UpdateMilestone,
  UpdateRequirementWork, UserSummary, Workspace,
} from '@ams/shared';
import { api as defaultApi } from './api';
import { unwrap, type Api, type FrameworkListItem, type Version } from './framework-api';

export type Program = z.infer<typeof ProgramSchema>;
export type CreateResult = z.infer<typeof CreateEngagementResultSchema>;
export type { Engagement, EngagementDetail, Member, Milestone, RequirementList, TemplateUpdate, UserSummary, Workspace };

/** All engagement calls, through the typed client. */
export function engagementApi(api: Api = defaultApi) {
  const e = api.api.engagements;
  return {
    me: () => api.api.me.$get().then((r) => unwrap<Me>(r)),
    list: () => e.$get().then((r) => unwrap<Engagement[]>(r)),
    create: (json: CreateEngagement) => e.$post({ json }).then((r) => unwrap<CreateResult>(r)),
    get: (id: string) => e[':id'].$get({ param: { id } }).then((r) => unwrap<EngagementDetail>(r)),
    update: (id: string, json: UpdateEngagement) => e[':id'].$patch({ param: { id }, json }).then((r) => unwrap<EngagementDetail>(r)),
    advance: (id: string) => e[':id']['advance-phase'].$post({ param: { id } }).then((r) => unwrap<EngagementDetail>(r)),
    withdraw: (id: string, reason: string) => e[':id'].withdraw.$post({ param: { id }, json: { reason } }).then((r) => unwrap<EngagementDetail>(r)),
    calendarUrl: (id: string) => `/api/engagements/${id}/calendar.ics`,

    members: (id: string) => e[':id'].members.$get({ param: { id } }).then((r) => unwrap<Member[]>(r)),
    addMember: (id: string, json: AddMember) => e[':id'].members.$post({ param: { id }, json }).then((r) => unwrap<Member[]>(r)),
    changeMember: (id: string, userId: string, role: AddMember['role']) =>
      e[':id'].members[':userId'].$patch({ param: { id, userId }, json: { role } }).then((r) => unwrap<Member[]>(r)),
    removeMember: (id: string, userId: string) => e[':id'].members[':userId'].$delete({ param: { id, userId } }).then((r) => unwrap<Member[]>(r)),
    handover: (id: string, json: { newLeadUserId: string; outgoingRole: Handover['outgoingRole'] }) => e[':id'].handover.$post({ param: { id }, json }).then((r) => unwrap<Member[]>(r)),

    addMilestone: (id: string, json: Partial<AddMilestone> & Pick<AddMilestone, 'phase' | 'name'>) => e[':id'].milestones.$post({ param: { id }, json }).then((r) => unwrap<Milestone>(r)),
    reorder: (id: string, json: ReorderMilestones) => e[':id'].milestones.reorder.$post({ param: { id }, json }).then((r) => unwrap<Milestone[]>(r)),
    updateMilestone: (id: string, json: UpdateMilestone) => api.api.milestones[':id'].$patch({ param: { id }, json }).then((r) => unwrap<Milestone>(r)),
    deleteMilestone: (id: string) => api.api.milestones[':id'].$delete({ param: { id } }).then((r) => unwrap<void>(r)),

    templateUpdate: (id: string) => e[':id']['template-update'].$get({ param: { id } }).then((r) => unwrap<TemplateUpdate>(r)),
    applyTemplateUpdate: (id: string, json: ApplyTemplateUpdate) =>
      e[':id']['template-update'].$post({ param: { id }, json }).then((r) => unwrap<{ applied: string[]; left: { id: string; reason: string }[]; syncedVersionId: string }>(r)),

    requirements: (id: string) => e[':id'].requirements.$get({ param: { id } }).then((r) => unwrap<RequirementList>(r)),
    assign: (id: string, json: AssignRequirements) => e[':id'].requirements.assign.$post({ param: { id }, json }).then((r) => unwrap<{ updated: number }>(r)),
    workspace: (id: string) => api.api['engagement-requirements'][':id'].$get({ param: { id } }).then((r) => unwrap<Workspace>(r)),
    work: (id: string, json: UpdateRequirementWork) => api.api['engagement-requirements'][':id'].$patch({ param: { id }, json }).then((r) => unwrap<Workspace>(r)),
    applicability: (id: string, json: SetApplicability) => api.api['engagement-requirements'][':id'].applicability.$post({ param: { id }, json }).then((r) => unwrap<Workspace>(r)),

    // Lookups for the wizard and assignment pickers.
    users: () => api.api.users.$get().then((r) => unwrap<UserSummary[]>(r)),
    programs: () => api.api.programs.$get().then((r) => unwrap<Program[]>(r)),
    frameworks: () => api.api.frameworks.$get().then((r) => unwrap<FrameworkListItem[]>(r)),
    versions: (frameworkId: string) => api.api.frameworks[':id'].versions.$get({ param: { id: frameworkId } }).then((r) => unwrap<Version[]>(r)),
  };
}
export type EngagementApi = ReturnType<typeof engagementApi>;

export const defaultEngagementApi = engagementApi();
export const useEngagementApi = (override?: EngagementApi) => override ?? defaultEngagementApi;
