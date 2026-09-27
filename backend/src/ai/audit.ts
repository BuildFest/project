import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../db.js";
import { newId } from "../ids.js";
import type { AiRunRecord } from "./router.js";

const context = new AsyncLocalStorage<{ projectId: string }>();

export function withAiProject<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  return context.run({ projectId }, work);
}

export function createAiRunLogger(db: Db): (record: AiRunRecord) => void {
  return (record) => {
    const projectId = context.getStore()?.projectId ?? null;
    void db.query(`insert into ai_runs
      (run_id,project_id,job,tier,provider,model,input_tokens,output_tokens,duration_ms,cached,status,error)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [newId("airun"), projectId, record.job, record.tier, record.provider, record.model,
       record.inputTokens, record.outputTokens, record.durationMs, record.cached, record.error ? "failed" : "success", record.error],
    ).catch((error) => console.error("could not record AI run", error));
  };
}
