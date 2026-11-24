// Auth-state reporting to the portal (ivrm-web #1684, slice S2).
//
// The session-resilience work (#10) keeps a shared login state
// (lib/session-resilience.mjs): per provider, "ok" or "expired".
// This module mirrors TRANSITIONS of that state to the portal so
// the server can notify opted-in members (dedicated role +
// portal opt-in) in a dedicated Discord channel when their
// HoYoLAB / Skport login expires. The extension only ever sends
// { provider, status } — no credential, cookie or token value
// beyond the Bearer link token that authorizes the call.
//
// Pure module, like the other lib files: the fetch function is
// injected, so node --test drives it with fakes and background.js
// passes the real fetch.
//
// Contract (fixed, shared with the portal side):
//   POST https://api.ivrm.jp/member/hoyolab/auth-state
//   Authorization: Bearer <link token>
//   { "provider": "hoyolab" | "skport", "status": "ok" | "expired" }
// The endpoint sits next to the link summary (ivrm-web #1675) and
// uses the same API base and the same stored token. The feature
// is gated server-side; while the gate is off the endpoint
// answers 404, which — like every other failure — is swallowed.
//
// Reporting rules:
// - Only transitions are reported: a provider is pending when its
//   current status differs from the last status the portal
//   acknowledged (storage key "authStateReported"). Before the
//   first successful report nothing is acknowledged, so the
//   current states are reported once as the baseline — which is
//   also what happens right after pairing saves a token.
// - At most one attempt per provider per sync. A failed attempt
//   leaves the acknowledged state untouched, so the next sync
//   (the next scheduled run, a startup, a token save) retries it
//   exactly once more — never a retry loop inside a sync.
// - No token, no report: members who never paired (or whose
//   token was removed) are simply not part of this feature.

import {
  AUTH_PROVIDERS,
  normalizeAuthState,
} from "./session-resilience.mjs";

export const AUTH_STATE_REPORT_URL =
  "https://api.ivrm.jp/member/hoyolab/auth-state";

// The same storage key the link-status feature (PR #7) saves the
// pairing token under; duplicated here as a literal because the
// two features live on separate branches — the value must match
// LINK_TOKEN_STORAGE_KEY in lib/hoyolab-link.mjs.
export const LINK_TOKEN_STORAGE_KEY = "portalLinkToken";

export const AUTH_REPORT_STORAGE_KEY = "authStateReported";

function normalizeReportedStatus(value) {
  return value === "ok" || value === "expired" ? value : null;
}

// The last portal-acknowledged status per provider; null means
// "never reported", so any current status is a transition from
// the server's point of view.
export function normalizeReportedState(raw) {
  const state = { hoyolab: null, skport: null };
  if (!raw || typeof raw !== "object") return state;
  for (const provider of AUTH_PROVIDERS) {
    state[provider] = normalizeReportedStatus(raw[provider]);
  }
  return state;
}

// The reports a sync should attempt now: one entry per provider
// whose current status the portal has not acknowledged yet.
export function pendingAuthReports(rawAuthState, rawReportedState) {
  const authState = normalizeAuthState(rawAuthState);
  const reported = normalizeReportedState(rawReportedState);
  const pending = [];
  for (const provider of AUTH_PROVIDERS) {
    const status = authState[provider].status;
    if (reported[provider] !== status) pending.push({ provider, status });
  }
  return pending;
}

export function applyReportedStatus(rawReportedState, provider, status) {
  const reported = normalizeReportedState(rawReportedState);
  if (AUTH_PROVIDERS.includes(provider)) {
    reported[provider] = normalizeReportedStatus(status);
  }
  return reported;
}

// One POST. Returns true only when the portal answered 2xx;
// every other outcome (network failure, 404 while the server
// gate is off, 401 for a revoked token, 5xx) is false and never
// throws — reporting must not disturb the check-in flows.
export async function postAuthState(fetchFn, token, provider, status) {
  let response;
  try {
    response = await fetchFn(AUTH_STATE_REPORT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider, status }),
    });
  } catch {
    return false;
  }
  return response.status >= 200 && response.status < 300;
}

// One sync pass: attempts each pending report once, in provider
// order, and folds the acknowledged ones into the reported
// state. Returns the new reported state plus what was attempted
// and what landed, for tests and logging. Without a token it is
// a no-op.
export async function syncAuthReports({
  fetchFn,
  token,
  authState,
  reportedState,
}) {
  let reported = normalizeReportedState(reportedState);
  const attempted = [];
  const delivered = [];
  if (typeof token !== "string" || token.length === 0) {
    return { reported, attempted, delivered };
  }
  for (const { provider, status } of pendingAuthReports(authState, reported)) {
    attempted.push({ provider, status });
    if (await postAuthState(fetchFn, token, provider, status)) {
      reported = applyReportedStatus(reported, provider, status);
      delivered.push({ provider, status });
    }
  }
  return { reported, attempted, delivered };
}
