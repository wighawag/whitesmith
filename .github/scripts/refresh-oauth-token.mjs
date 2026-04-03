#!/usr/bin/env node
/**
 * Refresh OAuth tokens in pi's auth.json before pi runs.
 *
 * Workaround for https://github.com/badlogic/pi-mono/issues/2743
 * pi-ai sends JSON to Anthropic's OAuth token endpoint, which now requires
 * application/x-www-form-urlencoded. We refresh the token ourselves.
 *
 * Handles rotating refresh tokens: each refresh invalidates the previous one,
 * so we always prefer cached tokens over the static PI_AUTH_JSON secret.
 *
 * Remove this script once the upstream fix is released.
 */
import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

const authPath = join(process.env.HOME, ".pi", "agent", "auth.json");
const cachePath = process.env.PI_AUTH_CACHE_PATH; // set by workflow

/**
 * Try to refresh using the given auth data.
 * Returns updated auth data on success, null on failure.
 */
async function tryRefresh(auth) {
  const cred = auth.anthropic;
  if (!cred || cred.type !== "oauth") return null;

  // Still valid — no refresh needed
  if (Date.now() < cred.expires) {
    console.log("Token still valid until", new Date(cred.expires).toISOString());
    return auth;
  }

  console.log("Token expired at", new Date(cred.expires).toISOString(), "- refreshing...");

  try {
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
      return null;
    }

    auth.anthropic = {
      type: "oauth",
      refresh: data.refresh_token,
      access: data.access_token,
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    };
    console.log("Token refreshed, new expiry:", new Date(auth.anthropic.expires).toISOString());
    return auth;
  } catch (err) {
    console.error("Refresh error:", err.message);
    return null;
  }
}

/**
 * Write auth data to auth.json and optionally to cache.
 */
function saveAuth(auth) {
  writeFileSync(authPath, JSON.stringify(auth, null, 2));
  chmodSync(authPath, 0o600);
  if (cachePath) {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(auth, null, 2));
    console.log("Auth cached for next run");
  }
}

// 1. Try cached auth first (has latest rotated refresh token)
if (cachePath && existsSync(cachePath)) {
  console.log("Found cached auth, trying cached tokens first...");
  const cachedAuth = JSON.parse(readFileSync(cachePath, "utf-8"));
  const result = await tryRefresh(cachedAuth);
  if (result) {
    saveAuth(result);
    process.exit(0);
  }
  console.log("Cached tokens failed, falling back to secret...");
}

// 2. Fall back to auth.json (written from PI_AUTH_JSON secret)
const auth = JSON.parse(readFileSync(authPath, "utf-8"));
const cred = auth.anthropic;

if (!cred || cred.type !== "oauth") {
  console.log("No OAuth credentials for anthropic, skipping refresh");
  process.exit(0);
}

const result = await tryRefresh(auth);
if (result) {
  saveAuth(result);
  process.exit(0);
}

console.error("All refresh attempts failed");
process.exit(1);
