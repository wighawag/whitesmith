#!/usr/bin/env node
/**
 * Refresh OAuth tokens in pi's auth.json before pi runs.
 *
 * Workaround for https://github.com/badlogic/pi-mono/issues/2743
 * pi-ai sends JSON to Anthropic's OAuth token endpoint, which now requires
 * application/x-www-form-urlencoded. We refresh the token ourselves.
 *
 * After refreshing, updates the PI_AUTH_JSON GitHub secret so the next run
 * has the latest rotated refresh token (requires GH_PAT with repo scope).
 *
 * Remove this script once the upstream fix is released.
 */
import { readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

const authPath = join(process.env.HOME, ".pi", "agent", "auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf-8"));
const cred = auth.anthropic;

if (!cred || cred.type !== "oauth") {
  console.log("No OAuth credentials for anthropic, skipping refresh");
  process.exit(0);
}

if (Date.now() < cred.expires) {
  console.log("Token still valid until", new Date(cred.expires).toISOString());
  process.exit(0);
}

console.log(
  "Token expired at",
  new Date(cred.expires).toISOString(),
  "- refreshing..."
);

const response = await fetch(ANTHROPIC_TOKEN_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: ANTHROPIC_CLIENT_ID,
    refresh_token: cred.refresh,
  }).toString(),
  signal: AbortSignal.timeout(30_000),
});

const data = await response.json();

if (!response.ok) {
  console.error("Refresh failed:", response.status, JSON.stringify(data));
  process.exit(1);
}

auth.anthropic = {
  type: "oauth",
  refresh: data.refresh_token,
  access: data.access_token,
  expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
};

writeFileSync(authPath, JSON.stringify(auth, null, 2));
chmodSync(authPath, 0o600);
console.log(
  "Token refreshed, new expiry:",
  new Date(auth.anthropic.expires).toISOString()
);

// Update the GitHub secret so the next run has the latest refresh token
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_PAT;
if (repo && token) {
  try {
    execSync(`gh secret set PI_AUTH_JSON --repo "${repo}"`, {
      input: JSON.stringify(auth),
      env: { ...process.env, GH_TOKEN: token },
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log("PI_AUTH_JSON secret updated");
  } catch (err) {
    console.warn("Failed to update secret (non-fatal):", err.stderr?.toString() || err.message);
  }
} else {
  console.log("Skipping secret update (no GH_PAT or GITHUB_REPOSITORY)");
}
