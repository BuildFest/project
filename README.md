URL: https://pit-crew-jwspsp1m5-pranshulpamecha06-6875s-projects.vercel.app/

# Pit Crew

Pit Crew is a project-aware agent for small software teams. It connects the team's plan with real GitHub activity so everyone can see what changed, what may be blocked, and whether the project is still on track.

Instead of acting like another task board that needs constant manual upkeep, Pit Crew maintains a living project model from the team's brief, structured plan, repository activity, and human corrections.

## What Pit Crew does

- Keeps a native rich-text project brief and a structured plan with tasks, owners, priorities, dependencies, milestones, and scope.
- Ingests GitHub pushes, commits, branches, pull requests, merges, and changed files.
- Backfills repository history when a repository is first connected and deduplicates it against webhook events.
- Builds an activity timeline from normalized, factual development events.
- Links development activity to tasks through task keys and optional AI-assisted inference.
- Derives explainable task states and project-health signals while allowing human overrides.
- Warns when active branches touch the same files without claiming that a merge conflict is guaranteed.
- Proposes plan changes for review; accepted changes create a new plan version, while rejected suggestions remain in project history.

Pit Crew is designed for coordination, not productivity surveillance. Its conclusions are evidence-backed, user corrections take precedence, and the core workflow continues to work when optional AI features are disabled.

## Core loop

```mermaid
flowchart LR
    A[Project brief and plan] --> B[Expected project state]
    C[GitHub activity] --> D[Observed project state]
    B --> E[Pit Crew analyzers]
    D --> E
    E --> F[Current state and timeline]
    E --> G[Health and collision signals]
    E --> H[Suggested replans]
```

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS, Tiptap |
| Backend | Node.js, TypeScript, Hono, Zod |
| Database | PostgreSQL 15+ with SQL migrations |
| GitHub integration | Signed webhooks plus REST API backfill |
| Optional AI | Groq, OpenAI, Microsoft Foundry agents, OpenRouter, or Anthropic through a two-tier model router |
| Deployment | Railway configuration for the backend; any Next.js-compatible host for the frontend |

## Architecture

Pit Crew separates data into three layers:

1. **Team-defined:** projects, briefs, plans, tasks, dependencies, milestones, and decisions.
2. **Factual:** repositories, webhook deliveries, and normalized GitHub events.
3. **Interpreted:** task links, derived task states, branch state, health signals, collision risks, timeline items, and replan suggestions.

Factual GitHub events are immutable. Rules and optional AI produce explainable interpretations without rewriting the underlying history.

## Local development

### Prerequisites

- A current Node.js LTS release and npm
- PostgreSQL 15 or newer
- A GitHub repository and token if you want live repository ingestion

### 1. Start the backend

Create an empty PostgreSQL database, then configure and start the API:

```bash
cd backend
npm install
cp .env.example .env
npm run migrate:dev
npm run dev
```

On PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

At minimum, set these values in `backend/.env` before starting the server:

```dotenv
DATABASE_URL=postgres://postgres:postgres@localhost:5432/pitcrew
GITHUB_WEBHOOK_SECRET=replace-with-a-long-random-secret
CORS_ORIGIN=http://localhost:3000
```

The API runs at `http://localhost:8787`. Verify it with:

```bash
curl http://localhost:8787/health
```

### 2. Start the frontend

In a second terminal:

```bash
cd frontend
npm install
cp .env.local.example .env.local
npm run dev
```

On PowerShell, use `Copy-Item .env.local.example .env.local` instead of `cp`.

Open `http://localhost:3000`. If `NEXT_PUBLIC_API_URL` is omitted, the frontend automatically uses its in-browser mock API; set it to `http://localhost:8787` to use the real backend.

## Configuration

Backend configuration lives in `backend/.env`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GITHUB_WEBHOOK_SECRET` | Yes | Verifies signed GitHub webhook deliveries |
| `PUBLIC_BASE_URL` | Production | Public HTTPS API URL used to construct the webhook endpoint |
| `GITHUB_TOKEN` | Private repositories | Fine-grained token with repository metadata, contents, and pull-request read access |
| `CORS_ORIGIN` | Recommended | Allowed frontend origin; defaults to `http://localhost:3000` in the example file |
| `AI_FAST_PROVIDER` / `AI_FAST_MODEL` | No | Provider and model for inexpensive inference jobs |
| `AI_SMART_PROVIDER` / `AI_SMART_MODEL` | No | Provider and model for reasoning-heavy jobs |
| `GROQ_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` | No | Credentials for enabled model providers |
| `AZURE_FOUNDRY_AGENT_ENDPOINT` | When using Foundry | Existing agent's OpenAI protocol endpoint from the Publish menu |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | When using Foundry | Entra service principal used by the backend to invoke the agent |
| `AI_DAILY_TOKEN_BUDGET` | No | Per-process daily token ceiling; `0` disables the cap |

To use an existing Microsoft Foundry agent for every AI job, set both tiers to
`foundry`. The model variables are labels used in audit records; the agent owns
its actual model configuration:

```dotenv
AI_FAST_PROVIDER=foundry
AI_FAST_MODEL=PitCrewer
AI_SMART_PROVIDER=foundry
AI_SMART_MODEL=PitCrewer
AZURE_FOUNDRY_AGENT_ENDPOINT=https://YOUR-ACCOUNT.services.ai.azure.com/api/projects/YOUR-PROJECT/agents/PitCrewer/endpoint/protocols/openai
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-calling-application-client-id
AZURE_CLIENT_SECRET=your-calling-application-secret
```

The backend invokes the agent's Responses endpoint with a Microsoft Entra token.
The calling service principal needs the Foundry Agent Consumer role on the
agent or project. The agent owns its model and reasoning settings; the backend
supplies project context and preserves JSON validation and retry behavior.

Frontend configuration lives in `frontend/.env.local`:

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Backend base URL; omit it to use the mock API |

## GitHub ingestion

After the backend has a public HTTPS URL:

1. Create a project in Pit Crew.
2. Connect a repository from the project workspace.
3. Add the returned webhook URL and secret to the repository's GitHub webhook settings.
4. Enable GitHub's push and pull-request events.
5. Start a backfill to import branches, pull requests, commits, and changed files that predate the webhook.

Webhook and backfill data share the same normalization and deduplication path, so replaying a delivery or running backfill again does not create duplicate project events.

## Development commands

### Backend

```bash
cd backend
npm run dev          # watch mode
npm run migrate:dev  # apply schema and pending migrations
npm test             # Vitest suite
npm run typecheck
npm run build
```

### Frontend

```bash
cd frontend
npm run dev
npm run lint
npm run build
```

## Repository layout

```text
backend/             Hono API, GitHub ingestion, analyzers, AI routing, and tests
db/                  PostgreSQL base schema and ordered migrations
docs/api-contract.md Frontend/backend HTTP contract
frontend/            Next.js dashboard and mock/real API adapters
```

## Documentation

- [Product brief and technical plan](https://docs.google.com/document/d/1JKtHkmCj_VnP_M5btIva2fkTeEKrXZsnhnNN26Y25ks/edit)
- [API contract](docs/api-contract.md)
- [Database schema](db/schema.sql)

## License

Pit Crew is available under the [MIT License](LICENSE).
