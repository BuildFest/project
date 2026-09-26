// Mock API. Every screen talks to the backend ONLY through this file.
// When Person 1's endpoints exist, replace each function body with a fetch()
// call — the rest of the app won't need to change.

import { Project } from "./types";

const STORAGE_KEY = "pitcrew.mock.projects";

function load(): Project[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(projects: Project[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(projects));
  } catch {
    /* ignore — mock only */
  }
}

export async function listProjects(): Promise<Project[]> {
  return load();
}

export async function getProject(id: string): Promise<Project | undefined> {
  return load().find((p) => p.id === id);
}

export async function createProject(
  input: Omit<Project, "id" | "tasks" | "createdAt">
): Promise<Project> {
  const project: Project = {
    ...input,
    id: crypto.randomUUID(),
    tasks: [],
    createdAt: new Date().toISOString(),
  };
  save([...load(), project]);
  return project;
}
