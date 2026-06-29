import { describe, expect, test } from "vitest";
import { AppError, exitCodes } from "../src/lib/errors.js";
import { jsonError } from "../src/lib/output.js";

describe("jsonError", () => {
  test("scrubs raw response bodies and secret-bearing keys from JSON details", () => {
    const output = jsonError(
      new AppError("API_ERROR", "Plane API request failed", exitCodes.api, {
        body: {
          access_token: "upstream-token",
          detail: "raw upstream response",
        },
        issues: [{ message: "Name is required", path: ["name"] }],
        password: "super-secret",
        searchPaths: ["/Users/test/.config/plane-cli/config.yml"],
        status: 500,
      }),
    );

    const parsed = JSON.parse(output.body);

    expect(parsed.error.details).toEqual({
      issues: [{ message: "Name is required", path: ["name"] }],
      searchPaths: ["/Users/test/.config/plane-cli/config.yml"],
      status: 500,
    });
    expect(output.body).not.toContain("upstream-token");
    expect(output.body).not.toContain("raw upstream response");
    expect(output.body).not.toContain("super-secret");
  });
});
