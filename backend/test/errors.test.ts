import { describe, expect, it } from "vitest";
import { ModelError } from "../src/ai/client.js";
import { InvalidModelReplyError } from "../src/ai/json.js";
import { AiUnavailableError } from "../src/ai/router.js";
import { aiErrorToHttp } from "../src/api/errors.js";

describe("aiErrorToHttp", () => {
  it("turns Foundry authorization failures into actionable errors", () => {
    expect(aiErrorToHttp(new ModelError("provider detail", 403, false))).toEqual({
      status: 502,
      body: { error: "Microsoft Foundry denied access; verify the Foundry Agent Consumer role" },
    });
  });

  it("does not expose an invalid model reply", () => {
    const mapped = aiErrorToHttp(new InvalidModelReplyError("schema detail", "sensitive reply"));
    expect(mapped).toEqual({
      status: 502,
      body: { error: "the planning agent returned an invalid response; try again" },
    });
    expect(mapped?.body.error).not.toContain("sensitive reply");
  });

  it("maps missing provider configuration and ignores unrelated errors", () => {
    expect(aiErrorToHttp(new AiUnavailableError("missing key"))?.status).toBe(503);
    expect(aiErrorToHttp(new Error("boom"))).toBeNull();
  });
});
