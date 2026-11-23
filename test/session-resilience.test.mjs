import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExchangeResponse,
  classifySignResponse,
} from "../src/lib/hoyolab-auto.mjs";
import { createAutoRunner } from "../src/lib/hoyolab-auto-runner.mjs";
import { classifySkportResponse } from "../src/lib/skport.mjs";
import { createSkportRunner } from "../src/lib/skport-runner.mjs";
import {
  MAX_DAILY_CHECKIN_RETRIES,
  anyAuthExpired,
  applyAuthSignal,
  isAuthOutcome,
  isAuthExpired,
  markAuthNotified,
  normalizeAuthState,
  normalizeRetryState,
  pendingAuthNotifications,
  shouldAttemptRetry,
} from "../src/lib/session-resilience.mjs";

// Session resilience (#10): the pure retry budget, the auth
// classification chain, the episode-based auth state, and the
// two runners' integration with both.

// ---------------------------------------------------------- retry budget

const DAY = "2026-01-15";

test("a pending check-in with budget left is retried", () => {
  assert.equal(
    shouldAttemptRetry({
      retry: { day: DAY, attempts: 0 },
      dayKey: DAY,
      pendingCount: 2,
      stopped: null,
    }),
    true
  );
  assert.equal(
    shouldAttemptRetry({
      retry: { day: DAY, attempts: MAX_DAILY_CHECKIN_RETRIES - 1 },
      dayKey: DAY,
      pendingCount: 1,
      stopped: null,
    }),
    true
  );
});

test("no retry once every game is done", () => {
  assert.equal(
    shouldAttemptRetry({
      retry: { day: DAY, attempts: 0 },
      dayKey: DAY,
      pendingCount: 0,
      stopped: null,
    }),
    false
  );
});

test("the daily retry cap stops further attempts", () => {
  assert.equal(
    shouldAttemptRetry({
      retry: { day: DAY, attempts: MAX_DAILY_CHECKIN_RETRIES },
      dayKey: DAY,
      pendingCount: 1,
      stopped: null,
    }),
    false
  );
});

test("a latched stop suppresses retries", () => {
  for (const stopped of ["risk_control", "not_logged_in", "disabled"]) {
    assert.equal(
      shouldAttemptRetry({
        retry: { day: DAY, attempts: 0 },
        dayKey: DAY,
        pendingCount: 1,
        stopped,
      }),
      false
    );
  }
});

test("the retry budget resets when the day rolls over", () => {
  const yesterday = { day: "2026-01-14", attempts: MAX_DAILY_CHECKIN_RETRIES };
  assert.deepEqual(normalizeRetryState(yesterday, DAY), {
    day: DAY,
    attempts: 0,
  });
  assert.equal(
    shouldAttemptRetry({
      retry: yesterday,
      dayKey: DAY,
      pendingCount: 1,
      stopped: null,
    }),
    true
  );
  // Same-day counters and malformed values are normalized, not trusted.
  assert.deepEqual(normalizeRetryState({ day: DAY, attempts: 2 }, DAY), {
    day: DAY,
    attempts: 2,
  });
  assert.deepEqual(normalizeRetryState(null, DAY), { day: DAY, attempts: 0 });
  assert.deepEqual(normalizeRetryState({ day: DAY, attempts: -3 }, DAY), {
    day: DAY,
    attempts: 0,
  });
});

// ---------------------------------------------------------- auth classification

test("HoYoLAB retcode -100 is the auth failure, other answers are not", () => {
  const auth = classifySignResponse(200, {
    retcode: -100,
    message: "not logged in",
    data: {},
  });
  assert.equal(auth, "not_logged_in");
  assert.equal(isAuthOutcome(auth), true);

  assert.equal(
    isAuthOutcome(
      classifySignResponse(200, { retcode: -5003, message: "", data: {} })
    ),
    false
  );
  assert.equal(
    isAuthOutcome(
      classifySignResponse(200, { retcode: 0, message: "OK", data: {} })
    ),
    false
  );
  assert.equal(
    classifyExchangeResponse(200, { retcode: -100, message: "", data: {} }),
    "not_logged_in"
  );
  const used = classifyExchangeResponse(200, {
    retcode: -2017,
    message: "already",
    data: {},
  });
  assert.equal(used, "already_used");
  assert.equal(isAuthOutcome(used), false);
});

test("Skport 401 / token answers are the auth failure, others are not", () => {
  assert.equal(classifySkportResponse(401, null), "not_logged_in");
  assert.equal(isAuthOutcome(classifySkportResponse(401, null)), true);
  assert.equal(
    classifySkportResponse(200, { code: 10001, message: "already signed" }),
    "already_done"
  );
  assert.equal(
    isAuthOutcome(classifySkportResponse(403, { code: 10001 })),
    false
  );
  assert.equal(
    isAuthOutcome(classifySkportResponse(200, { code: 0, data: {} })),
    false
  );
  assert.equal(
    classifySkportResponse(200, { code: 5, message: "Please login again" }),
    "not_logged_in"
  );
});

// ---------------------------------------------------------- auth state episodes

test("an expiry notifies once per episode and clears on success", () => {
  let state = normalizeAuthState(undefined);
  assert.equal(anyAuthExpired(state), false);

  const first = applyAuthSignal(state, "hoyolab", "expired", 1000);
  assert.equal(first.transition, "expired");
  state = first.state;
  assert.equal(isAuthExpired(state, "hoyolab"), true);
  assert.equal(state.hoyolab.since, 1000);
  assert.deepEqual(pendingAuthNotifications(state), ["hoyolab"]);

  // The surface marks it notified; further failures inside the
  // same episode neither re-notify nor move `since`.
  state = markAuthNotified(state, "hoyolab");
  assert.deepEqual(pendingAuthNotifications(state), []);
  const again = applyAuthSignal(state, "hoyolab", "expired", 2000);
  assert.equal(again.transition, "unchanged");
  assert.equal(again.state.hoyolab.since, 1000);
  assert.deepEqual(pendingAuthNotifications(again.state), []);

  // A success ends the episode and resets the notification flag,
  // so a later expiry is a new episode that notifies again.
  const cleared = applyAuthSignal(again.state, "hoyolab", "ok", 3000);
  assert.equal(cleared.transition, "cleared");
  assert.equal(anyAuthExpired(cleared.state), false);
  const second = applyAuthSignal(cleared.state, "hoyolab", "expired", 4000);
  assert.equal(second.transition, "expired");
  assert.deepEqual(pendingAuthNotifications(second.state), ["hoyolab"]);
});

test("the two providers' auth states are independent", () => {
  let { state } = applyAuthSignal(undefined, "skport", "expired", 1000);
  assert.equal(isAuthExpired(state, "skport"), true);
  assert.equal(isAuthExpired(state, "hoyolab"), false);
  ({ state } = applyAuthSignal(state, "hoyolab", "ok", 2000));
  assert.equal(isAuthExpired(state, "skport"), true);
  // Malformed stored values normalize to a clean slate.
  assert.deepEqual(normalizeAuthState({ hoyolab: "expired" }), {
    hoyolab: { status: "ok", since: null, notified: false },
    skport: { status: "ok", since: null, notified: false },
  });
});

// ---------------------------------------------------------- HoYoLAB runner

const NOW = new Date("2026-01-15T03:00:00Z"); // 12:00 JST, 11:00 UTC+8

function makeHoyolabHarness(options = {}) {
  const data = {
    settings: options.settings ?? {
      enabled: true,
      games: { genshin: true, starrail: true, zzz: true },
    },
    records: {},
    state: options.state ?? {},
    log: [],
    authState: undefined,
  };
  const control = { hasSession: options.hasSession ?? true };
  const calls = { fetch: [] };
  const signResults = options.signResults ?? {};

  async function fetchJson(url) {
    calls.fetch.push(url);
    if (url.includes("/sign")) {
      for (const [fragment, body] of Object.entries(signResults)) {
        if (url.includes(fragment)) return { status: 200, body };
      }
      return { status: 200, body: { retcode: 0, message: "OK", data: {} } };
    }
    throw new Error(`unexpected URL: ${url}`);
  }

  const runner = createAutoRunner({
    fetchJson,
    sleep: async () => {},
    now: () => new Date(NOW),
    hasSession: async () => control.hasSession,
    loadData: async () => data,
    saveData: async (patch) => {
      Object.assign(data, patch);
    },
  });
  return { runner, data, calls, control };
}

const signCalls = (calls) => calls.fetch.filter((url) => url.includes("/sign"));

test("a missing session marks the HoYoLAB auth state expired, recovery clears it", async () => {
  const { runner, data, control } = makeHoyolabHarness({ hasSession: false });
  const summary = await runner.runCheckinCycle();
  assert.equal(summary.stopReason, "not_logged_in");
  assert.equal(data.authState.hoyolab.status, "expired");
  assert.equal(typeof data.authState.hoyolab.since, "number");
  assert.equal(data.log.at(-1).kind, "auth");
  assert.equal(data.log.at(-1).outcome, "not_logged_in");

  control.hasSession = true;
  const recovered = await runner.runCheckinCycle();
  assert.equal(recovered.ran, true);
  assert.equal(data.authState.hoyolab.status, "ok");
});

test("a -100 sign answer marks the auth state expired mid-cycle", async () => {
  const { runner, data } = makeHoyolabHarness({
    signResults: {
      "event/sol": { retcode: -100, message: "not logged in", data: {} },
    },
  });
  const summary = await runner.runCheckinCycle();
  assert.equal(summary.stopReason, "not_logged_in");
  assert.equal(data.authState.hoyolab.status, "expired");
});

test("retry cycles spend the daily budget, then stop fetching", async () => {
  const failing = { retcode: -9999, message: "boom", data: {} };
  const { runner, data, calls } = makeHoyolabHarness({
    signResults: { "event/sol": failing, "event/luna": failing },
  });
  await runner.runCheckinCycle();
  assert.equal(signCalls(calls).length, 3);

  for (let i = 1; i <= MAX_DAILY_CHECKIN_RETRIES; i += 1) {
    const summary = await runner.runCheckinCycle({ retry: true });
    assert.equal(summary.ran, true);
    assert.equal(data.state.checkinRetry.attempts, i);
  }
  assert.equal(
    signCalls(calls).length,
    3 * (1 + MAX_DAILY_CHECKIN_RETRIES)
  );

  const exhausted = await runner.runCheckinCycle({ retry: true });
  assert.equal(exhausted.ran, false);
  assert.equal(exhausted.stopReason, "retry_limit");
  assert.equal(
    signCalls(calls).length,
    3 * (1 + MAX_DAILY_CHECKIN_RETRIES)
  );
});

test("a retry cycle after success fetches nothing", async () => {
  const { runner, calls } = makeHoyolabHarness();
  await runner.runCheckinCycle();
  assert.equal(signCalls(calls).length, 3);
  const summary = await runner.runCheckinCycle({ retry: true });
  assert.equal(summary.results.genshin, "already_done");
  assert.equal(signCalls(calls).length, 3);
});

test("a latched risk-control stop suppresses retries entirely", async () => {
  const { runner, data, calls } = makeHoyolabHarness({
    signResults: {
      "event/sol": {
        retcode: -3101,
        message: "risk",
        data: { gt: "x", challenge: "y" },
      },
    },
  });
  const first = await runner.runCheckinCycle();
  assert.equal(first.stopReason, "risk_control");
  const fetches = calls.fetch.length;
  const retry = await runner.runCheckinCycle({ retry: true });
  assert.equal(retry.stopReason, "risk_control");
  assert.equal(calls.fetch.length, fetches);
  assert.equal(data.state.checkinRetry.attempts, 0);
});

// ---------------------------------------------------------- Skport runner

function makeSkportHarness(options = {}) {
  const data = {
    settings: { enabled: true, games: {} },
    gameSettings: undefined,
    state: {},
    log: [],
    authState: undefined,
  };
  const control = {
    token: options.token === undefined ? "ACCOUNT_TOKEN" : options.token,
    claim: options.claim ?? { code: 0, data: { awardIds: [], resourceInfoMap: {} } },
  };
  const calls = { fetch: [] };

  async function fetchJson(url, fetchOptions = {}) {
    calls.fetch.push(url);
    if (url.includes("/user/info/v1/basic")) {
      return { status: 200, body: { status: 0, data: {} } };
    }
    if (url.includes("/user/oauth2/v2/grant")) {
      return { status: 200, body: { status: 0, data: { code: "CODE1" } } };
    }
    if (url.includes("generate_cred_by_code")) {
      return {
        status: 200,
        body: { code: 0, data: { cred: "CRED", token: "TOKEN1" } },
      };
    }
    if (url.includes("/web/v1/auth/refresh")) {
      return { status: 200, body: { code: 0, data: { token: "TOKEN2" } } };
    }
    if (url.includes("/api/v1/game/player/binding")) {
      return {
        status: 200,
        body: {
          code: 0,
          data: {
            list: [
              {
                appCode: "endfield",
                bindingList: [
                  { roles: [{ roleId: 12345, serverId: 5, nickname: "博士" }] },
                ],
              },
            ],
          },
        },
      };
    }
    if (url.includes("/web/v1/game/endfield/attendance")) {
      if (fetchOptions.method === "POST") {
        return { status: 200, body: control.claim };
      }
      return {
        status: 200,
        body: { code: 0, data: { hasToday: false, records: [] } },
      };
    }
    if (url.includes("/web/v1/game/endfield/card")) {
      return {
        status: 200,
        body: {
          code: 0,
          data: { stamina: { current: 100, max: 240, recoveryTime: null } },
        },
      };
    }
    throw new Error(`unexpected URL: ${url}`);
  }

  const runner = createSkportRunner({
    fetchJson,
    sleep: async () => {},
    now: () => new Date(NOW),
    getAccountToken: async () => control.token,
    sign: async () => "SIGN",
    loadData: async () => data,
    saveData: async (patch) => {
      if (patch.state !== undefined) data.state = patch.state;
      if (patch.log !== undefined) data.log = patch.log;
      if (patch.authState !== undefined) data.authState = patch.authState;
    },
  });
  return { runner, data, calls, control };
}

test("a missing Skport token marks the auth state expired, recovery clears it", async () => {
  const { runner, data, control } = makeSkportHarness({ token: null });
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.stopReason, "not_logged_in");
  assert.equal(data.authState.skport.status, "expired");
  assert.equal(
    data.log.some((entry) => entry.kind === "auth" && entry.game === "endfield"),
    true
  );

  control.token = "ACCOUNT_TOKEN";
  const recovered = await runner.runEndfieldCheckinCycle();
  assert.equal(recovered.results.endfield, "success");
  assert.equal(data.authState.skport.status, "ok");
});

test("Skport retry cycles spend the daily budget, then stop fetching", async () => {
  const { runner, data, calls } = makeSkportHarness({
    claim: { code: 999, message: "boom" },
  });
  const first = await runner.runEndfieldCheckinCycle();
  assert.equal(first.results.endfield, "failed");

  for (let i = 1; i <= MAX_DAILY_CHECKIN_RETRIES; i += 1) {
    const summary = await runner.runEndfieldCheckinCycle({ retry: true });
    assert.equal(summary.ran, true);
    assert.equal(data.state.checkinRetry.attempts, i);
  }
  const fetches = calls.fetch.length;
  const exhausted = await runner.runEndfieldCheckinCycle({ retry: true });
  assert.equal(exhausted.ran, false);
  assert.equal(exhausted.stopReason, "retry_limit");
  assert.equal(calls.fetch.length, fetches);
});

test("a Skport retry is not attempted while the login is known-expired", async () => {
  const { runner, data, calls } = makeSkportHarness({ token: null });
  await runner.runEndfieldCheckinCycle();
  assert.equal(data.state.sessionMissing, true);
  const fetches = calls.fetch.length;
  const summary = await runner.runEndfieldCheckinCycle({ retry: true });
  assert.equal(summary.stopReason, "not_logged_in");
  assert.equal(summary.ran, false);
  assert.equal(calls.fetch.length, fetches);
  assert.equal(data.state.checkinRetry.attempts, 0);
});
