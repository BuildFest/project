// Minimal GitHub REST client: headers, one-shot GETs, and Link-header paging.

const API = "https://api.github.com";

type Fetch = typeof fetch;

// Pinning the API version keeps response shapes stable; the token is optional
// for public repos, required for private ones.
export function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "pitcrew",
    "x-github-api-version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

export class GitHubError extends Error {
  constructor(readonly status: number, path: string) {
    super(`GitHub returned ${status} for ${path}`);
  }
}

export async function githubGet<T>(path: string, fetchImpl: Fetch = fetch): Promise<T> {
  const res = await fetchImpl(`${API}${path}`, { headers: githubHeaders() });
  if (!res.ok) throw new GitHubError(res.status, path);
  return (await res.json()) as T;
}

/** Follows rel="next" links (100 per page, GitHub's max) up to maxPages. */
export async function githubList<T>(path: string, fetchImpl: Fetch = fetch, maxPages = 10): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = `${API}${path}${path.includes("?") ? "&" : "?"}per_page=100`;
  for (let page = 0; url && page < maxPages; page++) {
    const res: Response = await fetchImpl(url, { headers: githubHeaders() });
    if (!res.ok) throw new GitHubError(res.status, path);
    items.push(...((await res.json()) as T[]));
    url = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
  }
  return items;
}
