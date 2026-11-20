import { describe, expect, it } from "vitest";
import { apiConfigWarnings, loadApiConfig } from "../src/config.js";

const env = {
  DATABASE_URL: "postgres://x", CORS_ORIGINS: "https://www.politicando.pt", RECAPTCHA_SECRET: "s", FORUM_SECRET: "f".repeat(32),
};

describe("API settings", () => {
  it("warns in production about local addresses and an open reCAPTCHA, without failing", () => {
    const warnings: string[] = [];
    const config = loadApiConfig({ ...env, NODE_ENV: "production" }, (message) => warnings.push(message));
    expect(config.SITE_URL).toBe("http://localhost:3000");
    expect(warnings).toEqual([
      expect.stringContaining("SITE_URL"),
      expect.stringContaining("PUBLIC_API_URL"),
      expect.stringContaining("RECAPTCHA_HOSTNAMES"),
    ]);
  });

  it("says nothing once they're set, or outside production", () => {
    expect(apiConfigWarnings({ ...env, NODE_ENV: "production", SITE_URL: "https://www.politicando.pt", PUBLIC_API_URL: "https://api.politicando.pt", RECAPTCHA_HOSTNAMES: "www.politicando.pt" })).toEqual([]);
    expect(apiConfigWarnings({ ...env, NODE_ENV: "development" })).toEqual([]);
  });
});
