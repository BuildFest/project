import { createHash } from "node:crypto";
import type pg from "pg";

// Export/restore of one project's complete state (spec R11: the demo must
// survive a webhook or hosting failure). The format is NDJSON:
//
//   {"kind":"header","format":"pitcrew-export","format_version":1,"project_id":…,"schema_version":…,"tables":{name:count}}
//   {"kind":"row","table":"github_events","data":{…}}          one per row
//   {"kind":"footer","rows":N,"sha256":"…"}                     hash of every line above, "\n"-terminated
//
// Tables are discovered, not listed: every table with a project_id column, plus
// the raw webhook deliveries behind the project's events. Person 2's tables
// travel without registration. Export files contain commit author emails
// (inside raw payloads) and private-repo data: treat them as confidential.

export const FORMAT = "pitcrew-export";
export const FORMAT_VERSION = 1;

// Values are Postgres's own text form (what psql prints), not JS values: a
// JS Date would drop timestamptz microseconds and a bigint would need care.
// Postgres parses the same text back on import, exactly, for every type.
type Row = Record<string, string | null>;
const RAW_TEXT = { getTypeParser: () => (value: string) => value };

async function projectTables(db: pg.Pool | pg.PoolClient): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `select c.table_name from information_schema.columns c
       join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and c.column_name = 'project_id' and t.table_type = 'BASE TABLE'
      order by c.table_name`,
  );
  // projects first so a reader sees the parent before its children.
  return ["projects", ...rows.map((r) => r.table_name).filter((t) => t !== "projects")];
}

/** Tables with a GENERATED ALWAYS identity column (github_events.seq) need OVERRIDING SYSTEM VALUE. */
async function hasIdentity(db: pg.Pool | pg.PoolClient, table: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and is_identity = 'YES'",
    [table],
  );
  return (rowCount ?? 0) > 0;
}

async function schemaVersion(db: pg.Pool | pg.PoolClient): Promise<string | null> {
  const { rows } = await db.query<{ version: string | null }>("select max(version) as version from schema_migrations");
  return rows[0].version;
}

// Table names come from information_schema, never from input; quote anyway.
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Writes one project as NDJSON lines through `write`. Returns the row count. */
export async function exportProject(db: pg.Pool, projectId: string, write: (line: string) => void | Promise<void>) {
  const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
  if (!rowCount) throw new Error(`project ${projectId} not found`);

  // One snapshot for the whole export, so tables are consistent with each other.
  const client = await db.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const tables = await projectTables(client);
    const data = new Map<string, Row[]>();
    for (const table of tables) {
      const order = table === "github_events" ? "order by seq" : "";
      const { rows } = await client.query<Row>({
        text: `select * from ${ident(table)} where project_id = $1 ${order}`,
        values: [projectId],
        types: RAW_TEXT,
      });
      data.set(table, rows);
    }
    // Raw deliveries behind this project's events (failed ones may have no repository_id).
    const { rows: deliveries } = await client.query<Row>({
      text: `select * from webhook_deliveries
              where repository_id in (select repository_id from repositories where project_id = $1)
                 or github_delivery_id in (select github_delivery_id from github_events where project_id = $1)
              order by received_at, github_delivery_id`,
      values: [projectId],
      types: RAW_TEXT,
    });
    data.set("webhook_deliveries", deliveries);
    const version = await schemaVersion(client);
    await client.query("commit");

    const hash = createHash("sha256");
    let rows = 0;
    const emit = async (obj: unknown) => {
      const line = JSON.stringify(obj);
      hash.update(`${line}\n`);
      await write(line);
    };
    await emit({
      kind: "header",
      format: FORMAT,
      format_version: FORMAT_VERSION,
      exported_at: new Date().toISOString(),
      project_id: projectId,
      schema_version: version,
      tables: Object.fromEntries([...data].map(([t, r]) => [t, r.length])),
    });
    for (const [table, tableRows] of data) {
      for (const row of tableRows) {
        await emit({ kind: "row", table, data: row });
        rows++;
      }
    }
    await write(JSON.stringify({ kind: "footer", rows, sha256: hash.digest("hex") }));
    return rows;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface Header {
  kind: "header";
  format: string;
  format_version: number;
  project_id: string;
  schema_version: string | null;
  tables: Record<string, number>;
}

/** Validates an export completely (hash, counts, format) before touching the database. */
export function parseExport(lines: string[]) {
  const body = lines.filter((l) => l.trim() !== "");
  if (body.length < 2) throw new Error("export is empty or truncated");
  const header = JSON.parse(body[0]) as Header;
  const footer = JSON.parse(body[body.length - 1]) as { kind: string; rows: number; sha256: string };
  if (header.kind !== "header" || header.format !== FORMAT) throw new Error("not a pitcrew export");
  if (header.format_version !== FORMAT_VERSION) throw new Error(`unsupported export format_version ${header.format_version}`);
  if (footer.kind !== "footer") throw new Error("export is truncated (no footer)");

  const hash = createHash("sha256");
  for (const line of body.slice(0, -1)) hash.update(`${line}\n`);
  if (hash.digest("hex") !== footer.sha256) throw new Error("export is corrupted (sha256 mismatch)");

  const rows = body.slice(1, -1).map((l) => JSON.parse(l) as { kind: "row"; table: string; data: Row });
  if (rows.length !== footer.rows) throw new Error(`export has ${rows.length} rows, footer says ${footer.rows}`);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.table] = (counts[r.table] ?? 0) + 1;
  for (const [table, n] of Object.entries(header.tables)) {
    if ((counts[table] ?? 0) !== n) throw new Error(`table ${table}: header says ${n} rows, found ${counts[table] ?? 0}`);
  }
  return { header, rows };
}

/**
 * Restores an export into a database that doesn't have this project yet.
 * The target must be migrated at least as far as the export was. Needs a
 * superuser (true for Railway's and Docker's default postgres user): foreign
 * keys and triggers are paused for the load, because the schema has FK
 * cycles (projects <-> plan_versions <-> replan_suggestions) and github_events
 * is append-only by trigger. Integrity comes from the export's own hash.
 */
export async function importProject(db: pg.Pool, lines: string[]) {
  const { header, rows } = parseExport(lines);

  const client = await db.connect();
  try {
    const target = await schemaVersion(client);
    if (header.schema_version && (!target || target < header.schema_version)) {
      throw new Error(`target database is at migration ${target}, export needs ${header.schema_version}: run migrations first`);
    }
    const { rowCount } = await client.query("select 1 from projects where project_id = $1", [header.project_id]);
    if (rowCount) throw new Error(`project ${header.project_id} already exists in the target database`);

    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const identity = new Map<string, boolean>();
    for (const { table, data } of rows) {
      if (!identity.has(table)) identity.set(table, await hasIdentity(client, table));
      const cols = Object.keys(data);
      const values = cols.map((c) => data[c]); // Postgres text form; the column type parses it
      await client.query(
        `insert into ${ident(table)} (${cols.map(ident).join(", ")})
         ${identity.get(table) ? "overriding system value" : ""}
         values (${cols.map((_, i) => `$${i + 1}`).join(", ")})
         on conflict do nothing`,
        values,
      );
    }
    // Restored seq values were explicit; move the sequence past them.
    await client.query(
      `select setval(pg_get_serial_sequence('public.github_events', 'seq'),
                     greatest((select max(seq) from github_events), 1))`,
    );
    await client.query("commit");
    return { projectId: header.project_id, rows: rows.length, tables: header.tables };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
