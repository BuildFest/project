import type { ModelRouter } from "../ai/router.js";
import { withAiProject } from "../ai/audit.js";
import type { Db } from "../db.js";
import { newId } from "../ids.js";
import { runMaintainer, type MaintainerOutput } from "./agent.js";
import { loadMaintainerFacts } from "./tools.js";

export interface MaintainerNote extends MaintainerOutput { note_id: string; project_id: string; kind: "digest" | "answer"; question: string | null; created_at?: Date }

async function generate(db: Db, router: ModelRouter | null, projectId: string, kind: "digest" | "ask", question?: string): Promise<MaintainerNote | null> {
  const facts = await loadMaintainerFacts(db, projectId);
  if (!facts) return null;
  const output = await withAiProject(projectId, () => runMaintainer(router, facts, kind, question));
  const noteId = newId("note");
  const { rows: [note] } = await db.query(`insert into maintainer_notes
    (note_id,project_id,kind,title,body,note,question,citations,generated_by)
    values ($1,$2,$3,$4,$5,$5,$6,$7,$8) returning *`,
    [noteId, projectId, kind === "ask" ? "answer" : "digest", output.title, output.body, question ?? null, JSON.stringify(output.citations), output.generated_by]);
  return { ...note, error: output.error };
}

export const generateDigest = (db: Db, router: ModelRouter | null, projectId: string) => generate(db, router, projectId, "digest");
export const askPitCrew = (db: Db, router: ModelRouter | null, projectId: string, question: string) => generate(db, router, projectId, "ask", question);

export function startMaintainerDigests(db: Db, router: ModelRouter | null, configuredMs = Number(process.env.MAINTAINER_DIGEST_MS ?? 21_600_000)) {
  const intervalMs = Number.isFinite(configuredMs) && configuredMs >= 1_000 ? configuredMs : 21_600_000;
  const sweep = async () => {
    try {
      const { rows } = await db.query<{ project_id: string }>(`select p.project_id from projects p
        where p.status='active' and not exists (
          select 1 from maintainer_notes n where n.project_id=p.project_id and n.kind='digest'
            and n.created_at > now() - ($1::bigint * interval '1 millisecond'))
        order by p.created_at, p.project_id`, [intervalMs]);
      // Sequential generation avoids a startup burst against the model budget.
      for (const row of rows) await generateDigest(db, router, row.project_id);
    } catch (error) { console.error("maintainer digest sweep failed", error); }
  };
  void sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return timer;
}
