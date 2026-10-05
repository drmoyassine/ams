import { OpenAPIHono, z, type Hook } from '@hono/zod-openapi';
import {
  addLocalMilestone, addMember, engagementCalendar, advancePhase, applyTemplateUpdate, assignRequirements, changeMemberRole, createEngagement, deleteMilestone,
  getEngagement, getTemplateUpdate, getWorkspace, handoverLead, listEngagementRequirements, listEngagements, listMembers, removeMember,
  reorderMilestones, setApplicability, updateEngagement, updateMilestone, updateRequirementWork, withdrawEngagement,
} from '@ams/core';
import {
  AddMemberSchema, AddMilestoneSchema, ApplyTemplateUpdateSchema, AssignRequirementsSchema, ChangeMemberSchema, CreateEngagementResultSchema,
  CreateEngagementSchema, EngagementDetailSchema, EngagementSchema, HandoverSchema, MemberSchema, MilestoneSchema, ReorderMilestonesSchema,
  RequirementListSchema, SetApplicabilitySchema, TemplateUpdateSchema, UpdateEngagementSchema, UpdateMilestoneSchema, UpdateRequirementWorkSchema,
  WithdrawSchema, WorkspaceSchema, toDto,
} from '@ams/shared';
import { requires, secured, type AppEnv, type ChainDeps, type RouteRegistry } from '../chain.js';
import { errors, idParam, json } from './common.js';

const memberParam = z.object({ id: z.uuid(), userId: z.uuid() });
const MembersSchema = z.array(MemberSchema);
const AssignResultSchema = z.object({ updated: z.number() });

// The chain checks that the caller holds the permission somewhere; the services then check it for the engagement or
// requirement in question (a lead of one engagement is not a lead of another), and row-level security hides the rest.
export function engagementRoutes(registry: RouteRegistry, deps: ChainDeps, options: { defaultHook: Hook<unknown, AppEnv, string, unknown> }) {
  const tag = ['engagements'];
  const detail = async (c: { get(k: 'ctx'): import('@ams/core').Ctx }, id: string) => toDto(EngagementDetailSchema, await getEngagement(c.get('ctx'), id));
  return new OpenAPIHono<AppEnv>(options)
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagements', access: requires('engagement:read'), tags: tag,
      responses: { 200: { description: 'Engagements the caller can see', ...json(z.array(EngagementSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(EngagementSchema), await listEngagements(c.get('ctx'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements', access: requires('engagement:create'), tags: tag,
      request: { body: { required: true, ...json(CreateEngagementSchema) } },
      responses: { 201: { description: 'Created with its lead, requirements and roadmap', ...json(CreateEngagementResultSchema) }, ...errors },
    }), async (c) => c.json(toDto(CreateEngagementResultSchema, await createEngagement(c.get('ctx'), c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagements/{id}', access: requires('engagement:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The engagement, its phases, members and roadmap', ...json(EngagementDetailSchema) }, ...errors },
    }), async (c) => c.json(await detail(c, c.req.valid('param').id), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/engagements/{id}', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateEngagementSchema) } },
      responses: { 200: { description: 'Updated; dates that follow the key dates are recomputed', ...json(EngagementDetailSchema) }, ...errors },
    }), async (c) => {
      const { id } = c.req.valid('param');
      await updateEngagement(c.get('ctx'), id, c.req.valid('json'));
      return c.json(await detail(c, id), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements/{id}/advance-phase', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Moved to the next phase', ...json(EngagementDetailSchema) }, ...errors },
    }), async (c) => {
      const { id } = c.req.valid('param');
      await advancePhase(c.get('ctx'), id);
      return c.json(await detail(c, id), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements/{id}/withdraw', access: requires('engagement:lead'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(WithdrawSchema) } },
      responses: { 200: { description: 'Withdrawn', ...json(EngagementDetailSchema) }, ...errors },
    }), async (c) => {
      const { id } = c.req.valid('param');
      await withdrawEngagement(c.get('ctx'), id, c.req.valid('json').reason);
      return c.json(await detail(c, id), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagements/{id}/calendar.ics', access: requires('engagement:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Milestones with a due date as an iCalendar file', content: { 'text/calendar': { schema: z.string() } } }, ...errors },
    }), async (c) => {
      const { filename, ics } = await engagementCalendar(c.get('ctx'), c.req.valid('param').id);
      return c.body(ics, 200, { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` });
    })

    // ---- Members ----
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagements/{id}/members', access: requires('engagement:read'), tags: tag,
      request: { params: idParam }, responses: { 200: { description: 'Members, lead first', ...json(MembersSchema) }, ...errors },
    }), async (c) => c.json(toDto(MembersSchema, await listMembers(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements/{id}/members', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(AddMemberSchema) } },
      responses: { 201: { description: 'Added', ...json(MembersSchema) }, ...errors },
    }), async (c) => c.json(toDto(MembersSchema, await addMember(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/engagements/{id}/members/{userId}', access: requires('engagement:manage'), tags: tag,
      request: { params: memberParam, body: { required: true, ...json(ChangeMemberSchema) } },
      responses: { 200: { description: 'Role changed', ...json(MembersSchema) }, ...errors },
    }), async (c) => {
      const { id, userId } = c.req.valid('param');
      return c.json(toDto(MembersSchema, await changeMemberRole(c.get('ctx'), id, userId, c.req.valid('json').role)), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/engagements/{id}/members/{userId}', access: requires('engagement:manage'), tags: tag,
      request: { params: memberParam }, responses: { 200: { description: 'Removed', ...json(MembersSchema) }, ...errors },
    }), async (c) => {
      const { id, userId } = c.req.valid('param');
      return c.json(toDto(MembersSchema, await removeMember(c.get('ctx'), id, userId)), 200);
    })

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements/{id}/handover', access: requires('engagement:lead'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(HandoverSchema) } },
      responses: { 200: { description: 'The lead role moved', ...json(MembersSchema) }, ...errors },
    }), async (c) => c.json(toDto(MembersSchema, await handoverLead(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    // ---- Roadmap ----
    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements/{id}/milestones', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(AddMilestoneSchema) } },
      responses: { 201: { description: 'A local milestone added', ...json(MilestoneSchema) }, ...errors },
    }), async (c) => c.json(toDto(MilestoneSchema, await addLocalMilestone(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 201))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements/{id}/milestones/reorder', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(ReorderMilestonesSchema) } },
      responses: { 200: { description: 'The phase in its new order', ...json(z.array(MilestoneSchema)) }, ...errors },
    }), async (c) => c.json(toDto(z.array(MilestoneSchema), await reorderMilestones(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/milestones/{id}', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateMilestoneSchema) } },
      responses: { 200: { description: 'Updated', ...json(MilestoneSchema) }, ...errors },
    }), async (c) => c.json(toDto(MilestoneSchema, await updateMilestone(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'delete', path: '/api/milestones/{id}', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam }, responses: { 204: { description: 'Deleted (only milestones the lead added)' }, ...errors },
    }), async (c) => { await deleteMilestone(c.get('ctx'), c.req.valid('param').id); return c.body(null, 204); })

    // ---- Template update ----
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagements/{id}/template-update', access: requires('engagement:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Changes a newer framework version would make, if any', ...json(TemplateUpdateSchema) }, ...errors },
    }), async (c) => c.json(toDto(TemplateUpdateSchema, await getTemplateUpdate(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements/{id}/template-update', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(ApplyTemplateUpdateSchema) } },
      responses: {
        200: { description: 'Decisions applied', ...json(z.object({ applied: z.array(z.string()), left: z.array(z.object({ id: z.string(), reason: z.string() })), syncedVersionId: z.string() })) },
        ...errors,
      },
    }), async (c) => c.json(await applyTemplateUpdate(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')), 200))

    // ---- Requirements ----
    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagements/{id}/requirements', access: requires('engagement:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'Requirements in tree order, with counts by status', ...json(RequirementListSchema) }, ...errors },
    }), async (c) => c.json(toDto(RequirementListSchema, await listEngagementRequirements(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagements/{id}/requirements/assign', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(AssignRequirementsSchema) } },
      responses: { 200: { description: 'Assigned', ...json(AssignResultSchema) }, ...errors },
    }), async (c) => c.json(await assignRequirements(c.get('ctx'), c.req.valid('param').id, c.req.valid('json')), 200))

    .openapi(secured(registry, deps, {
      method: 'get', path: '/api/engagement-requirements/{id}', access: requires('engagement:read'), tags: tag,
      request: { params: idParam },
      responses: { 200: { description: 'The requirement workspace', ...json(WorkspaceSchema) }, ...errors },
    }), async (c) => c.json(toDto(WorkspaceSchema, await getWorkspace(c.get('ctx'), c.req.valid('param').id)), 200))

    .openapi(secured(registry, deps, {
      method: 'patch', path: '/api/engagement-requirements/{id}', access: requires('engagement:read'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(UpdateRequirementWorkSchema) } },
      responses: { 200: { description: 'Updated: owners and reviewers act on what is assigned to them, the lead on all', ...json(WorkspaceSchema) }, ...errors },
    }), async (c) => c.json(toDto(WorkspaceSchema, await updateRequirementWork(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200))

    .openapi(secured(registry, deps, {
      method: 'post', path: '/api/engagement-requirements/{id}/applicability', access: requires('engagement:manage'), tags: tag,
      request: { params: idParam, body: { required: true, ...json(SetApplicabilitySchema) } },
      responses: { 200: { description: 'Switched on or off, with a reason', ...json(WorkspaceSchema) }, ...errors },
    }), async (c) => c.json(toDto(WorkspaceSchema, await setApplicability(c.get('ctx'), c.req.valid('param').id, c.req.valid('json'))), 200));
}
