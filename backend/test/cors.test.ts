import { afterEach, describe, expect, it } from "vitest";
import { corsOrigins, createApp } from "../src/api/app.js";
import type { Db } from "../src/db.js";

describe("corsOrigins", () => {
  it("parses a comma-separated list, trimming spaces and trailing slashes", () => {
    expect(corsOrigins(" http://localhost:3000 , https://pitcrew-web.up.railway.app/ ")).toEqual([
      "http://localhost:3000",
      "https://pitcrew-web.up.railway.app",
    ]);
  });

  it("falls back to the local dev server when unset or empty", () => {
    expect(corsOrigins(undefined)).toEqual(["http://localhost:3000"]);
    expect(corsOrigins("")).toEqual(["http://localhost:3000"]);
    expect(corsOrigins(" , ")).toEqual(["http://localhost:3000"]);
  });
});

describe("CORS preflight", () => {
  const saved = process.env.CORS_ORIGIN;
  afterEach(() => {
    process.env.CORS_ORIGIN = saved;
  });

  // Preflight is answered by the middleware before any route touches the db.
  async function allowOrigin(origin: string) {
    const app = createApp({} as Db);
    const res = await app.request("/projects", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    return res.headers.get("access-control-allow-origin");
  }

  it("allows every listed origin and nothing else", async () => {
    process.env.CORS_ORIGIN = "http://localhost:3000,https://pitcrew-web.up.railway.app/";
    expect(await allowOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(await allowOrigin("https://pitcrew-web.up.railway.app")).toBe("https://pitcrew-web.up.railway.app");
    expect(await allowOrigin("https://evil.example")).toBeNull();
  });
});
