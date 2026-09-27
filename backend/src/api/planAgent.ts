import type { Hono } from "hono";
import { z } from "zod";
import type { ModelRouter } from "../ai/router.js";
import { bootstrapPlanFromBrief } from "../analysis/planBootstrap.js";
import { runAnalysis } from "../analysis/runner.js";
import type { Db } from "../db.js";
import { parseBody } from "./http.js";
import { loadWorkspaces } from "./workspace.js";

const AgentInput = z.object({ member_id: z.string().min(1).nullable().default(null) });

export function registerPlanAgentRoutes(app: Hono, db: Db, router: ModelRouter | null) {
  app.post("/projects/:projectId/plan-agent/bootstrap", async (c) => {
    const input = await parseBody(c, AgentInput);
    const projectId = c.req.param("projectId");
    const result = await bootstrapPlanFromBrief(db, router, projectId, input.member_id);
    const analysis = await runAnalysis(db, router, projectId);
    const [workspace] = await loadWorkspaces(db, [projectId]);
    return c.json({ ...result, analysis, workspace }, 201);
  });

  app.post("/projects/:projectId/plan-agent/run", async (c) => {
    await parseBody(c, AgentInput);
    const projectId = c.req.param("projectId");
    const analysis = await runAnalysis(db, router, projectId);
    const [workspace] = await loadWorkspaces(db, [projectId]);
    return c.json({ analysis, workspace });
  });
}
