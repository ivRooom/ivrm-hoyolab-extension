// Session resilience for the automation features
// (ivrm-hoyolab-extension #10): daytime retries for a check-in
// that has not landed yet, and a shared "login expired" state
// that the badge, the notifications and the popup banner all read.
//
// Pure module, like the other lib files: no chrome.* APIs, no
// fetch. The runners fold their outcomes into the state kept
// here; background.js renders the state (badge / notification);
// popup.js renders it too (banner).
//
// Why these measures: the automation rides on the browser's own
// HoYoLAB / Skport login, and that login can end while Chrome is
// closed or asleep — the 01:05 / 05:05 alarm then finds no
// session and the day's check-in is silently lost. Nothing can
// re-login on the user's behalf (no credential is stored, by
// design), so the extension instead (1) retries during the day
// when a run merely failed or was missed, and (2) notices an
// expired login once, says so loudly, and goes quiet until a run
// succeeds again.

// ----------------------------------------------------------------
// Daytime retry budget
//
// The main daily alarm stays the primary attempt. On top of it, a
// repeating retry alarm (background.js) re-runs the check-in
// cycles during the day; each runner consults shouldAttemptRetry
// before spending one of the day's retry attempts. The budget is
// keyed by the runner's own day (HoYoLAB day / Skport day), so
// the two runners keep separate counters in their own state.

export const CHECKIN_RETRY_INTERVAL_MINUTES = 120; // ~2 hours
export const MAX_DAILY_CHECKIN_RETRIES = 4;

export function emptyRetryState() {
  return { day: null, attempts: 0 };
}

// Folds a stored counter into today's: a counter from another
// day is yesterday's budget and resets to zero.
export function normalizeRetryState(raw, dayKey) {
  if (!raw || typeof raw !== "object" || raw.day !== dayKey) {
    return { day: dayKey, attempts: 0 };
  }
  return {
    day: dayKey,
    attempts:
      typeof raw.attempts === "number" && raw.attempts > 0
        ? Math.floor(raw.attempts)
        : 0,
  };
}

// Whether a retry-triggered cycle may actually attempt the
// pending games now. `stopped` is a latched stop reason for the
// runner ("risk_control" / "not_logged_in" / "disabled") or null:
// a latched risk-control stop always wins (only a manual run
// clears it), and an expired login is handled by the auth surface
// below, not by hammering the API every two hours.
export function shouldAttemptRetry({ retry, dayKey, pendingCount, stopped }) {
  if (stopped) return false;
  if (typeof pendingCount !== "number" || pendingCount <= 0) return false;
  return (
    normalizeRetryState(retry, dayKey).attempts < MAX_DAILY_CHECKIN_RETRIES
  );
}

// ----------------------------------------------------------------
// Auth (login) state
//
// Storage key "authState", one entry per provider:
//   { status: "ok" | "expired", since: <ms|null>, notified: bool }
// `since` is when the current expiry episode began; `notified`
// makes the notification episode-based — one notification per
// episode, however many runs fail inside it. Any success clears
// the entry (status ok, notified reset), so a later expiry is a
// new episode and notifies again.

export const AUTH_STATE_KEY = "authState";
export const AUTH_PROVIDERS = ["hoyolab", "skport"];

export const AUTH_LOGIN_URLS = {
  hoyolab: "https://www.hoyolab.com/",
  skport: "https://game.skport.com/",
};

function emptyAuthEntry() {
  return { status: "ok", since: null, notified: false };
}

export function emptyAuthState() {
  return { hoyolab: emptyAuthEntry(), skport: emptyAuthEntry() };
}

function normalizeAuthEntry(raw) {
  if (!raw || typeof raw !== "object") return emptyAuthEntry();
  return {
    status: raw.status === "expired" ? "expired" : "ok",
    since: typeof raw.since === "number" ? raw.since : null,
    notified: raw.notified === true,
  };
}

export function normalizeAuthState(raw) {
  const state = emptyAuthState();
  if (!raw || typeof raw !== "object") return state;
  for (const provider of AUTH_PROVIDERS) {
    state[provider] = normalizeAuthEntry(raw[provider]);
  }
  return state;
}

// The outcome vocabulary's one auth failure: both HoYoLAB
// classifiers map retcode -100 to it, and the Skport classifier
// maps HTTP 401 / token messages to it.
export function isAuthOutcome(outcome) {
  return outcome === "not_logged_in";
}

// Folds one runner signal into the state. signal is "expired"
// (an auth failure was seen) or "ok" (a call succeeded, so the
// session demonstrably works). Returns the new state plus the
// transition: "expired" (a new episode began), "cleared" (an
// episode ended), or "unchanged". A repeated "expired" signal
// inside an episode keeps the original `since` and `notified`.
export function applyAuthSignal(rawState, provider, signal, nowMs) {
  const state = normalizeAuthState(rawState);
  const entry = state[provider];
  let transition = "unchanged";
  if (signal === "expired" && entry.status !== "expired") {
    state[provider] = {
      status: "expired",
      since: typeof nowMs === "number" ? nowMs : null,
      notified: false,
    };
    transition = "expired";
  } else if (signal === "ok" && entry.status === "expired") {
    state[provider] = emptyAuthEntry();
    transition = "cleared";
  }
  return { state, transition };
}

export function isAuthExpired(rawState, provider) {
  return normalizeAuthState(rawState)[provider].status === "expired";
}

export function anyAuthExpired(rawState) {
  const state = normalizeAuthState(rawState);
  return AUTH_PROVIDERS.some((provider) => state[provider].status === "expired");
}

// Providers whose current episode has not been notified yet.
export function pendingAuthNotifications(rawState) {
  const state = normalizeAuthState(rawState);
  return AUTH_PROVIDERS.filter(
    (provider) =>
      state[provider].status === "expired" && state[provider].notified === false
  );
}

export function markAuthNotified(rawState, provider) {
  const state = normalizeAuthState(rawState);
  if (state[provider].status === "expired") {
    state[provider] = { ...state[provider], notified: true };
  }
  return state;
}
