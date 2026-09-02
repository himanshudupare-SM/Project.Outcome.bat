import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  addProjectMemberInput,
  createEpicInput,
  createProjectInput,
  updateProjectInput,
} from '@outcome/shared';
import * as projects from '../../modules/projects/service.js';
import * as tasks from '../../modules/tasks/service.js';
import { listActivity } from '../../modules/activity/service.js';
import { requireOrg, resolveProject } from '../context.js';

const projectParams = z.object({ projectKey: z.string().min(1).max(64) });

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/orgs/:orgSlug/projects', async (req) => {
    const ctx = await requireOrg(req);
    const query = z
      .object({ includeArchived: z.coerce.boolean().default(false) })
      .parse(req.query);
    return projects.listProjects(ctx, query.includeArchived);
  });

  app.post('/orgs/:orgSlug/projects', async (req, reply) => {
    const ctx = await requireOrg(req);
    const input = createProjectInput.parse(req.body);
    return reply.status(201).send(await projects.createProject(ctx, input));
  });

  app.get('/orgs/:orgSlug/projects/:projectKey', async (req) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    return projects.getDetail(ctx, project);
  });

  app.patch('/orgs/:orgSlug/projects/:projectKey', async (req) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    return projects.updateProject(ctx, project, updateProjectInput.parse(req.body));
  });

  app.delete('/orgs/:orgSlug/projects/:projectKey', async (req) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    await projects.archiveProject(ctx, project);
    return { ok: true };
  });

  app.post('/orgs/:orgSlug/projects/:projectKey/members', async (req, reply) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    const input = addProjectMemberInput.parse(req.body);
    await projects.addMember(ctx, project, input.userId, input.role);
    return reply.status(201).send({ ok: true });
  });

  app.delete('/orgs/:orgSlug/projects/:projectKey/members/:userId', async (req) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    await projects.removeMember(ctx, project, userId);
    return { ok: true };
  });

  app.get('/orgs/:orgSlug/projects/:projectKey/epics', async (req) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    return projects.listEpics(ctx, project);
  });

  app.post('/orgs/:orgSlug/projects/:projectKey/epics', async (req, reply) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    return reply.status(201).send(await projects.createEpic(ctx, project, createEpicInput.parse(req.body)));
  });

  app.get('/orgs/:orgSlug/projects/:projectKey/board', async (req) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    const [detail, columns] = await Promise.all([
      projects.getDetail(ctx, project),
      tasks.board(ctx, project),
    ]);
    return { project: detail, columns };
  });

  app.get('/orgs/:orgSlug/projects/:projectKey/blockers', async (req) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    return tasks.listOpenBlockers(ctx, project);
  });

  app.get('/orgs/:orgSlug/projects/:projectKey/activity', async (req) => {
    const ctx = await requireOrg(req);
    const { projectKey } = projectParams.parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() })
      .parse(req.query);
    return listActivity(ctx, { projectId: project.id, ...query });
  });
}
