import type { FastifyInstance } from "fastify";
import type { z } from "zod";

import { createProjectSchema, updateProjectSchema } from "../schemas";
import { denyRole } from "../middleware/auth";
import type { RouteContext } from "./context";

export function registerProjectRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.get("/api/projects", { preHandler: app.authenticate }, async (request) => {
    const user = await ctx.service.getUserByUsername(request.user.username);
    return {
      projects: await ctx.projectService.listProjects(),
      currentProjectId: user?.currentProjectId ?? "default_project",
    };
  });

  app.post<{ Body: z.infer<typeof createProjectSchema> }>(
    "/api/projects",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = createProjectSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid project payload." });
      const result = await ctx.projectService.createProject({
        name: parsed.data.name,
        description: parsed.data.description,
        createdBy: request.user.username,
      });
      return reply.code(201).send(result);
    },
  );

  app.patch<{ Params: { projectId: string }; Body: z.infer<typeof updateProjectSchema> }>(
    "/api/projects/:projectId",
    { preHandler: [app.authenticate, denyRole("viewer")] },
    async (request, reply) => {
      const parsed = updateProjectSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? "Invalid project update." });
      const project = await ctx.projectService.updateProject(request.params.projectId, parsed.data);
      if (!project) return reply.code(404).send({ error: "未找到该项目。" });
      return { project };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/select",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const user = await ctx.projectService.selectProject(request.user.username, request.params.projectId);
      if (!user) return reply.code(404).send({ error: "未找到当前用户。" });
      return {
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          displayName: user.displayName,
          currentProjectId: user.currentProjectId,
        },
      };
    },
  );
}
