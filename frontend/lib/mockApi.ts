// In-browser mock backend (localStorage). Used when NEXT_PUBLIC_API_URL is not
// set, so the UI works before/without the real backend. lib/api.ts decides
// which one to call — components never import this file directly.

import type {
  GithubEvent,
  Milestone,
  Page,
  ProjectWorkspace,
  Task,
  TaskDependency,
} from "./types";

const STORAGE_KEY = "pitcrew.mock.workspaces.v2";

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 26).toUpperCase()}`;
}

function load(): ProjectWorkspace[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(all: ProjectWorkspace[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* ignore — mock only */
  }
}

export async function listProjects(): Promise<ProjectWorkspace[]> {
  return load();
}

export async function getProject(projectId: string): Promise<ProjectWorkspace | undefined> {
  return load().find((w) => w.project.project_id === projectId);
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  task_key_prefix: string;
  deadline_at: string | null;
  members: { display_name: string; github_login: string | null }[];
  brief: string;
}

export async function createProject(input: CreateProjectInput): Promise<ProjectWorkspace> {
  const now = new Date().toISOString();
  const project_id = newId("proj");
  const members = input.members.map((m, i) => ({
    member_id: newId("mem"),
    project_id,
    display_name: m.display_name,
    role_label: null,
    github_login: m.github_login,
    access_level: i === 0 ? ("owner" as const) : ("editor" as const),
    joined_at: now,
  }));

  const workspace: ProjectWorkspace = {
    project: {
      project_id,
      name: input.name,
      description: input.description ?? null,
      task_key_prefix: input.task_key_prefix,
      next_task_number: 1,
      created_by: members[0]?.member_id ?? "system",
      created_at: now,
      updated_at: now,
      deadline_at: input.deadline_at,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      status: "active",
      current_plan_version: null,
      primary_repository_id: null,
    },
    members,
    brief: {
      project_id,
      content: input.brief,
      content_format: "markdown",
      updated_at: now,
      updated_by: members[0]?.member_id ?? null,
    },
    milestones: [],
    tasks: [],
    dependencies: [],
  };

  save([...load(), workspace]);
  return workspace;
}

// ============================================================================
// Plan editing
// ============================================================================


// Load, change one workspace, save, and return a fresh copy for React state.
async function mutate(
  projectId: string,
  fn: (w: ProjectWorkspace) => void
): Promise<ProjectWorkspace> {
  const all = load();
  const w = all.find((x) => x.project.project_id === projectId);
  if (!w) throw new Error("Project not found");
  fn(w);
  w.project.updated_at = new Date().toISOString();
  save(all);
  return structuredClone(w);
}

export async function updateBrief(projectId: string, content: string) {
  return mutate(projectId, (w) => {
    w.brief.content = content;
    w.brief.updated_at = new Date().toISOString();
  });
}

export async function addMilestone(
  projectId: string,
  input: { name: string; target_at: string | null }
) {
  return mutate(projectId, (w) => {
    const m: Milestone = {
      milestone_id: newId("ms"),
      project_id: projectId,
      name: input.name,
      description: null,
      target_at: input.target_at,
      sort_order: w.milestones.length,
      archived: false,
    };
    w.milestones.push(m);
  });
}

export async function archiveMilestone(projectId: string, milestoneId: string) {
  return mutate(projectId, (w) => {
    const m = w.milestones.find((x) => x.milestone_id === milestoneId);
    if (m) m.archived = true;
    for (const t of w.tasks) if (t.milestone_id === milestoneId) t.milestone_id = null;
  });
}

export async function addTask(projectId: string, title: string) {
  return mutate(projectId, (w) => {
    const n = w.project.next_task_number;
    w.project.next_task_number = n + 1;
    const t: Task = {
      task_id: newId("task"),
      task_key: `${w.project.task_key_prefix}-${n}`,
      project_id: projectId,
      title,
      description: null,
      owner_member_id: null,
      priority: "medium",
      scope: "must_have",
      plan_status: "not_started",
      milestone_id: null,
      target_at: null,
      sort_order: w.tasks.length,
      archived: false,
    };
    w.tasks.push(t);
  });
}

export type TaskPatch = Partial<
  Pick<
    Task,
    | "title"
    | "description"
    | "owner_member_id"
    | "priority"
    | "scope"
    | "plan_status"
    | "milestone_id"
    | "target_at"
    | "archived"
  >
>;

export async function updateTask(projectId: string, taskId: string, patch: TaskPatch) {
  return mutate(projectId, (w) => {
    const t = w.tasks.find((x) => x.task_id === taskId);
    if (!t) throw new Error("Task not found");
    Object.assign(t, patch);
  });
}

// True if "taskId depends on dependsOnId" would create a loop
// (i.e. dependsOnId already depends, directly or indirectly, on taskId).
export function wouldCreateCycle(
  deps: TaskDependency[],
  taskId: string,
  dependsOnId: string
): boolean {
  if (taskId === dependsOnId) return true;
  const stack = [dependsOnId];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of deps) if (d.task_id === cur) stack.push(d.depends_on_task_id);
  }
  return false;
}

export async function addDependency(projectId: string, taskId: string, dependsOnId: string) {
  return mutate(projectId, (w) => {
    const exists = w.dependencies.some(
      (d) => d.task_id === taskId && d.depends_on_task_id === dependsOnId
    );
    if (exists) return;
    if (wouldCreateCycle(w.dependencies, taskId, dependsOnId)) {
      throw new Error("That dependency would create a loop");
    }
    w.dependencies.push({
      project_id: projectId,
      task_id: taskId,
      depends_on_task_id: dependsOnId,
      dependency_type: "requires",
    });
  });
}

export async function removeDependency(projectId: string, taskId: string, dependsOnId: string) {
  return mutate(projectId, (w) => {
    w.dependencies = w.dependencies.filter(
      (d) => !(d.task_id === taskId && d.depends_on_task_id === dependsOnId)
    );
  });
}

// ============================================================================
// Sample GitHub events (mock only)
// Generated once per project from its tasks so branch names/keys line up with
// the plan, then kept in localStorage so the list is stable across reloads.
// Includes one overlapping-file branch pair so collision UI has data later.
// ============================================================================

const EVENTS_KEY = "pitcrew.mock.events.v1";

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "work";
}

function sha() {
  return Array.from({ length: 40 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
}

function generateEvents(w: ProjectWorkspace): GithubEvent[] {
  const pid = w.project.project_id;
  const repo = "repo_MOCK";
  const logins = w.members.map((m) => m.github_login).filter((x): x is string => !!x);
  const people = logins.length ? logins : ["rameez99", "divij404"];
  const tasks = w.tasks.filter((t) => !t.archived).slice(0, 4);
  const plan = tasks.length
    ? tasks.map((t) => ({ key: t.task_key, title: t.title }))
    : [
        { key: `${w.project.task_key_prefix}-1`, title: "project setup" },
        { key: `${w.project.task_key_prefix}-2`, title: "api routes" },
      ];

  const events: GithubEvent[] = [];
  let t = Date.now() - 9 * 60 * 60 * 1000; // start ~9h ago
  const tick = (min: number) => (t += min * 60 * 1000);
  let pr = 1;

  const base = (type: GithubEvent["event_type"], actor: string, branch: string | null): GithubEvent => ({
    event_id: newId("event"),
    project_id: pid,
    repository_id: repo,
    source: "webhook",
    external_event_id: crypto.randomUUID(),
    event_type: type,
    actor,
    occurred_at: new Date(t).toISOString(),
    ingested_at: new Date(t + 2000).toISOString(),
    branch,
    commit: null,
    pull_request: null,
    changed_files: [],
  });

  const shared = "frontend/lib/api.ts"; // touched by two branches → collision

  plan.forEach((p, i) => {
    const who = people[i % people.length];
    const branch = `${p.key.toLowerCase()}-${slug(p.title)}`;
    tick(25 + i * 7);
    events.push(base("branch_created", who, branch));

    const files = [
      [`backend/src/${slug(p.title)}.ts`, `backend/test/${slug(p.title)}.test.ts`],
      [`frontend/components/${slug(p.title)}.tsx`, i === 1 || i === 2 ? shared : "frontend/app/page.tsx"],
    ];
    files.forEach((changed, j) => {
      tick(35 + j * 12);
      const s = sha();
      events.push(base("push", who, branch));
      events.push({
        ...base("commit", who, branch),
        commit: {
          sha: s,
          message: j === 0 ? `${p.key}: start ${p.title}` : `${p.key}: wire ${p.title} into UI`,
          author: who,
          url: `https://github.com/example/repo/commit/${s}`,
        },
        changed_files: changed,
      });
    });

    if (i < 3) {
      tick(20);
      const number = pr++;
      const prBody = {
        number,
        title: `${p.key} ${p.title}`,
        state: "open",
        head_branch: branch,
        base_branch: "main",
        url: `https://github.com/example/repo/pull/${number}`,
        merged: false,
      };
      events.push({ ...base("pull_request_opened", who, branch), pull_request: prBody, changed_files: files.flat() });
      if (i === 0) {
        tick(40);
        events.push({
          ...base("pull_request_merged", people[(i + 1) % people.length], branch),
          pull_request: { ...prBody, state: "closed", merged: true },
          changed_files: files.flat(),
        });
      }
    }
  });

  // A commit that doesn't mention any task key → stays unlinked.
  tick(15);
  const s = sha();
  events.push({
    ...base("commit", people[0], "main"),
    commit: { sha: s, message: "fix typo in README", author: people[0], url: `https://github.com/example/repo/commit/${s}` },
    changed_files: ["README.md"],
  });

  return events.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

export function mockEventsFor(w: ProjectWorkspace): GithubEvent[] {
  // Keyed by the first few task keys/titles, so sample events regenerate when
  // the plan changes and branch names keep matching real tasks.
  const sig = w.tasks
    .filter((t) => !t.archived)
    .slice(0, 4)
    .map((t) => `${t.task_key}:${t.title}`)
    .join("|");
  const projectId = `${w.project.project_id}#${sig}`;
  let all: Record<string, GithubEvent[]> = {};
  try {
    all = JSON.parse(localStorage.getItem(EVENTS_KEY) ?? "{}");
  } catch {
    all = {};
  }
  if (!all[projectId]) {
    all[projectId] = generateEvents(w);
    try {
      localStorage.setItem(EVENTS_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }
  return all[projectId];
}

export async function listEvents(
  projectId: string,
  opts: { branch?: string; limit?: number; cursor?: string | null } = {}
): Promise<Page<GithubEvent>> {
  const w = load().find((x) => x.project.project_id === projectId);
  if (!w) throw new Error("Project not found");
  const events = mockEventsFor(w);

  const limit = Math.min(opts.limit ?? 50, 200);
  const start = opts.cursor ? Number(opts.cursor) : 0;
  const items = events.filter((e) => !opts.branch || e.branch === opts.branch);
  const page = items.slice(start, start + limit);
  return {
    items: page,
    next_cursor: start + limit < items.length ? String(start + limit) : null,
  };
}

export function resetMockEvents(projectId: string) {
  try {
    const all: Record<string, unknown> = JSON.parse(localStorage.getItem(EVENTS_KEY) ?? "{}");
    for (const k of Object.keys(all)) if (k.startsWith(`${projectId}#`)) delete all[k];
    localStorage.setItem(EVENTS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

export function mockWorkspace(projectId: string): ProjectWorkspace {
  const w = load().find((x) => x.project.project_id === projectId);
  if (!w) throw new Error("Project not found");
  return w;
}

// ============================================================================
// Repositories (mock). Simulates GitHub's webhook "ping" a few seconds after
// connecting so the UI's pending -> connected transition can be tested.
// ============================================================================

const REPOS_KEY = "pitcrew.mock.repos.v1";

function loadRepos(): Record<string, import("./types").Repository[]> {
  try {
    return JSON.parse(localStorage.getItem(REPOS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export async function listRepositories(projectId: string) {
  const all = loadRepos();
  const now = Date.now();
  let changed = false;
  for (const r of all[projectId] ?? []) {
    if (r.connection_status === "pending" && r.connected_at && now - new Date(r.connected_at).getTime() > 8000) {
      r.connection_status = "connected";
      r.last_event_at = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) localStorage.setItem(REPOS_KEY, JSON.stringify(all));
  return all[projectId] ?? [];
}

export async function connectRepository(projectId: string, fullName: string) {
  const m = fullName.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(m)) throw new Error(`GitHub doesn't know "${fullName}". Use owner/repo, e.g. BuildFest/project.`);
  const all = loadRepos();
  if ((all[projectId] ?? []).some((r) => r.full_name.toLowerCase() === m.toLowerCase())) {
    throw new Error("That repository is already connected to this project.");
  }
  const [owner, name] = m.split("/");
  const repo: import("./types").Repository = {
    repository_id: newId("repo"),
    project_id: projectId,
    provider: "github",
    owner,
    name,
    full_name: m,
    default_branch: "main",
    connection_status: "pending",
    connected_at: new Date().toISOString(), // mock: used as "created" for the fake ping
    last_backfill_at: null,
    last_event_at: null,
  };
  all[projectId] = [...(all[projectId] ?? []), repo];
  localStorage.setItem(REPOS_KEY, JSON.stringify(all));
  return {
    repository: repo,
    webhook_url: "https://pitcrew.example.dev/webhooks/github",
    webhook_secret: crypto.randomUUID().replace(/-/g, ""),
  };
}

export async function startBackfill(projectId: string, repositoryId: string) {
  const all = loadRepos();
  const r = (all[projectId] ?? []).find((x) => x.repository_id === repositoryId);
  if (r) r.last_backfill_at = new Date().toISOString();
  localStorage.setItem(REPOS_KEY, JSON.stringify(all));
  return { started_at: new Date().toISOString() };
}
