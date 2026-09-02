import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createBlockerInput,
  createCommentInput,
  createDependencyInput,
  createLabelInput,
  createTaskInput,
  moveTaskInput,
  taskListQuery,
  updateTaskInput,
} from '@outcome/shared';
import * as tasks from '../../modules/tasks/service.js';
import * as comments from '../../modules/comments/service.js';
import { myWork } from '../../modules/tasks/mywork.js';
import { listActivity } from '../../modules/activity/service.js';
import { requireOrg, resolveProject } from '../context.js';

const idParam = z.object({ id: z.string().uuid() });

export async function registerTaskRoutes(app: FastifyInstance): Promise<void> {
  app.get('/orgs/:orgSlug/tasks', async (req) => {
    const ctx = await requireOrg(req);
    const query = taskListQuery.parse(req.query);
    const project = query.projectId ? await resolveProject(ctx, query.projectId) : null;
    return tasks.listTasks(ctx, query, project);
  });

  app.post('/orgs/:orgSlug/projects/:projectKey/tasks', async (req, reply) => {
    const ctx = await requireOrg(req);
    const { projectKey } = z.object({ projectKey: z.string() }).parse(req.params);
    const project = await resolveProject(ctx, projectKey);
    const input = createTaskInput.parse(req.body);
    return reply.status(201).send(await tasks.createTask(ctx, project, input));
  });

  app.get('/orgs/:orgSlug/projects/:projectKey/tasks/:number', async (req) => {
    const ctx = await requireOrg(req);
    const params = z
      .object({ projectKey: z.string(), number: z.coerce.number().int().positive() })
      .parse(req.params);
    const project = await resolveProject(ctx, params.projectKey);
    return tasks.getTaskByRef(ctx, project, params.number);
  });

  app.get('/orgs/:orgSlug/tasks/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    return tasks.getTask(ctx, id);
  });

  app.patch('/orgs/:orgSlug/tasks/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    return tasks.updateTask(ctx, id, updateTaskInput.parse(req.body));
  });

  app.post('/orgs/:orgSlug/tasks/:id/move', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    return tasks.moveTask(ctx, id, moveTaskInput.parse(req.body));
  });

  app.delete('/orgs/:orgSlug/tasks/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    await tasks.deleteTask(ctx, id);
    return { ok: true };
  });

  // ---- dependencies ----
  app.post('/orgs/:orgSlug/tasks/:id/dependencies', async (req, reply) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    const input = createDependencyInput.parse(req.body);
    await tasks.addDependency(ctx, id, input.blockingTaskId);
    return reply.status(201).send({ ok: true });
  });

  app.delete('/orgs/:orgSlug/tasks/:id/dependencies/:blockingTaskId', async (req) => {
    const ctx = await requireOrg(req);
    const params = z
      .object({ id: z.string().uuid(), blockingTaskId: z.string().uuid() })
      .parse(req.params);
    await tasks.removeDependency(ctx, params.id, params.blockingTaskId);
    return { ok: true };
  });

  // ---- blockers ----
  app.post('/orgs/:orgSlug/tasks/:id/blockers', async (req, reply) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    const input = createBlockerInput.parse(req.body);
    return reply.status(201).send(await tasks.addBlocker(ctx, id, input));
  });

  app.post('/orgs/:orgSlug/blockers/:id/resolve', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    await tasks.resolveBlocker(ctx, id);
    return { ok: true };
  });

  app.get('/orgs/:orgSlug/blockers', async (req) => {
    const ctx = await requireOrg(req);
    return tasks.listOpenBlockers(ctx, null);
  });

  // ---- comments ----
  app.get('/orgs/:orgSlug/tasks/:id/comments', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    return comments.list(ctx, id);
  });

  app.post('/orgs/:orgSlug/tasks/:id/comments', async (req, reply) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    const input = createCommentInput.parse(req.body);
    return reply.status(201).send(await comments.create(ctx, id, input));
  });

  app.patch('/orgs/:orgSlug/comments/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    const input = createCommentInput.parse(req.body);
    return comments.update(ctx, id, input.body);
  });

  app.delete('/orgs/:orgSlug/comments/:id', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    await comments.remove(ctx, id);
    return { ok: true };
  });

  // ---- task activity ----
  app.get('/orgs/:orgSlug/tasks/:id/activity', async (req) => {
    const ctx = await requireOrg(req);
    const { id } = idParam.parse(req.params);
    await tasks.getTask(ctx, id); // access check
    const query = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() })
      .parse(req.query);
    return listActivity(ctx, { taskId: id, ...query });
  });

  // ---- labels ----
  app.get('/orgs/:orgSlug/labels', async (req) => {
    const ctx = await requireOrg(req);
    return tasks.listLabels(ctx);
  });

  app.post('/orgs/:orgSlug/labels', async (req, reply) => {
    const ctx = await requireOrg(req);
    const input = createLabelInput.parse(req.body);
    return reply.status(201).send(await tasks.createLabel(ctx, input.name, input.color));
  });

  // ---- my work ----
  app.get('/orgs/:orgSlug/my-work', async (req) => {
    const ctx = await requireOrg(req);
    return myWork(ctx);
  });
}
