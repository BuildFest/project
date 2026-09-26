# Backup and restore (demo Plan B)

If the webhook, Railway, or the network fails during judging, the dashboard
must still show our real history. An export captures one project's complete
state; a restore rebuilds it in any empty Postgres (e.g. Docker on the demo
laptop).

Exports contain commit author emails (inside raw webhook payloads) and
private-repo data. Keep them off public repos and chats.

## Export from production

Railway's internal `DATABASE_URL` isn't reachable from a laptop. Use the
Postgres service's **`DATABASE_PUBLIC_URL`** (Railway → Postgres → Variables).

```powershell
cd backend
$env:DATABASE_URL = "<DATABASE_PUBLIC_URL>"
npm run export -- proj_01M3FX961CHR91GC2819PAKNWQ pitcrew-$(Get-Date -Format yyyyMMdd-HHmm).ndjson.gz
```

Write to a file argument, not with `>`: PowerShell 5.1 re-encodes redirected
output as UTF-16. A failed export deletes its partial file.

When: at each checkpoint, at the feature freeze, and an hour before judging.
Keep the latest three in two places (the demo laptop and the team drive).

## Restore on the demo laptop

```powershell
docker run -d --name pitcrew-demo -p 127.0.0.1:5433:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=pitcrew postgres:16
cd backend
$env:DATABASE_URL = "postgres://postgres:pw@127.0.0.1:5433/pitcrew"
npm run import -- pitcrew-20261004-1500.ndjson.gz
```

`import` runs the migrations first, verifies the file's SHA-256 and row
counts before writing anything, and refuses if the project already exists
(restore into an empty database; drop and recreate it to redo).

Then run the backend against it (`npm run dev` with the same `DATABASE_URL`
and any `GITHUB_WEBHOOK_SECRET`) and point the frontend at
`http://localhost:8787`.

## What's in an export

NDJSON: a header (project, schema version, row count per table), one line per
row, and a footer with the SHA-256 of everything above. Every table with a
`project_id` column is included automatically (Person 2's tables too), plus
the raw webhook deliveries behind the project's events. Values are stored in
Postgres's own text form, so timestamps, JSON and event `seq` numbers restore
exactly.
