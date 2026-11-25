import assert from "node:assert/strict";
import test from "node:test";
import { createSkportRunner } from "../src/lib/skport-runner.mjs";
import { skportDateKey } from "../src/lib/skport.mjs";

// The Skport runner with faked dependencies: an in-memory store, a
// URL router standing in for the Gryphline / Skport APIs, a fixed
// clock, and a sign function that records what it was asked to
// sign. This exercises the OAuth exchange, the hasToday gate, the
// claim, the risk-control latch, the per-game settings gate (#6),
// and the sanity read — with no network.

const NOW = new Date("2026-01-15T03:00:00Z"); // 12:00 JST, Skport day 2026-01-15

function makeHarness(options = {}) {
  const data = {
    settings: options.settings ?? { enabled: true, games: {} },
    gameSettings: options.gameSettings,
    state: options.state ?? {},
    log: [],
  };
  const calls = { fetch: [], sign: [], sleep: [] };
  const attendance = options.attendance ?? {
    hasToday: false,
    claim: {
      code: 0,
      data: {
        awardIds: [{ id: "a1" }],
        resourceInfoMap: { a1: { name: "折金票", count: 500 } },
      },
    },
  };
  const roles = options.roles ?? [
    {
      roleId: 12345,
      serverId: 5,
      nickname: "博士",
      level: 10,
      serverName: "Asia",
    },
  ];

  async function fetchJson(url, fetchOptions = {}) {
    calls.fetch.push({ url, options: fetchOptions });
    if (url.includes("/user/info/v1/basic")) {
      if (options.basicInfo) return options.basicInfo;
      return { status: 200, body: { status: 0, data: {} } };
    }
    if (url.includes("/user/oauth2/v2/grant")) {
      return { status: 200, body: { status: 0, data: { code: "CODE1" } } };
    }
    if (url.includes("generate_cred_by_code")) {
      return {
        status: 200,
        body: { code: 0, data: { cred: "CRED", token: "TOKEN1", userId: "9" } },
      };
    }
    if (url.includes("/web/v1/auth/refresh")) {
      if (options.refreshFails) {
        return { status: 200, body: { code: 1, message: "nope" } };
      }
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
                bindingList: [{ roles }],
              },
            ],
          },
        },
      };
    }
    if (url.includes("/web/v1/game/endfield/attendance")) {
      if (fetchOptions.method === "POST") {
        if (attendance.claim instanceof Error) throw attendance.claim;
        return { status: 200, body: attendance.claim };
      }
      return {
        status: 200,
        body: { code: 0, data: { hasToday: attendance.hasToday, records: [] } },
      };
    }
    if (url.includes("/web/v1/game/endfield/card")) {
      if (options.card) return options.card;
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

  async function sign(request) {
    calls.sign.push(request);
    return "SIGN";
  }

  const saved = { state: null, log: null };
  const runner = createSkportRunner({
    fetchJson,
    sleep: async (ms) => {
      calls.sleep.push(ms);
    },
    now: () => NOW,
    getAccountToken: async () =>
      options.accountToken === undefined ? "ACCOUNT_TOKEN" : options.accountToken,
    sign,
    loadData: async () => ({
      settings: data.settings,
      gameSettings: data.gameSettings,
      state: data.state,
      log: data.log,
    }),
    saveData: async (patch) => {
      if (patch.state !== undefined) {
        data.state = patch.state;
        saved.state = patch.state;
      }
      if (patch.log !== undefined) {
        data.log = patch.log;
        saved.log = patch.log;
      }
    },
  });
  return { runner, data, calls, saved };
}

function attendancePosts(calls) {
  return calls.fetch.filter(
    (call) =>
      call.url.includes("/attendance") && call.options.method === "POST"
  );
}

test("a full cycle claims the check-in and caches the sanity reading", async () => {
  const { runner, data, calls } = makeHarness();
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.ran, true);
  assert.equal(summary.results.endfield, "success");
  assert.equal(attendancePosts(calls).length, 1);
  // The day record is keyed by the Skport day (04:00 UTC+8 reset).
  assert.equal(data.state.checkin.endfield.day, skportDateKey(NOW));
  // The log entry names the claimed reward.
  const entry = data.log.find((e) => e.kind === "checkin");
  assert.equal(entry.game, "endfield");
  assert.equal(entry.outcome, "success");
  assert.match(entry.detail, /折金票 x500/);
  // Sanity from the card endpoint is cached for the popup.
  assert.equal(data.state.sanity.current, 100);
  assert.equal(data.state.sanity.max, 240);
  // Signing used the refreshed token (TOKEN2), not the OAuth one.
  assert.ok(calls.sign.length > 0);
  assert.ok(calls.sign.every((s) => s.signToken === "TOKEN2"));
  // The claim carried the sk-game-role header for the bound role.
  const post = attendancePosts(calls)[0];
  assert.equal(post.options.headers["sk-game-role"], "3_12345_5");
  assert.equal(post.options.headers.cred, "CRED");
});

test("a failed sign-token refresh falls back to the OAuth token", async () => {
  const { runner, calls } = makeHarness({ refreshFails: true });
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.results.endfield, "success");
  assert.ok(calls.sign.every((s) => s.signToken === "TOKEN1"));
});

test("hasToday skips the claim POST entirely", async () => {
  const { runner, data, calls } = makeHarness({
    attendance: { hasToday: true, claim: { code: 0, data: {} } },
  });
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.results.endfield, "already_done");
  assert.equal(attendancePosts(calls).length, 0);
  assert.equal(data.state.checkin.endfield.day, skportDateKey(NOW));
});

test("a second cycle on the same Skport day does nothing", async () => {
  const { runner, calls } = makeHarness();
  await runner.runEndfieldCheckinCycle();
  const fetches = calls.fetch.length;
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.ran, false);
  assert.equal(summary.results.endfield, "already_done");
  assert.equal(calls.fetch.length, fetches);
});

test("no ACCOUNT_TOKEN means not logged in, and nothing is fetched", async () => {
  const { runner, data, calls } = makeHarness({ accountToken: null });
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.stopReason, "not_logged_in");
  assert.equal(calls.fetch.length, 0);
  assert.equal(data.state.sessionMissing, true);
  assert.equal(
    data.log.filter((e) => e.outcome === "not_logged_in").length,
    1
  );
});

test("an expired ACCOUNT_TOKEN is reported as not logged in", async () => {
  const { runner } = makeHarness({
    basicInfo: { status: 200, body: { status: 1, msg: "invalid token" } },
  });
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.stopReason, "not_logged_in");
});

test("the master switch and the per-game switches gate the cycle", async () => {
  const master = makeHarness({ settings: { enabled: false, games: {} } });
  assert.equal(
    (await master.runner.runEndfieldCheckinCycle()).stopReason,
    "disabled"
  );
  assert.equal(master.calls.fetch.length, 0);

  const hidden = makeHarness({
    gameSettings: { display: { endfield: false } },
  });
  assert.equal(
    (await hidden.runner.runEndfieldCheckinCycle()).stopReason,
    "disabled"
  );
  assert.equal(hidden.calls.fetch.length, 0);

  const autoOff = makeHarness({
    gameSettings: { automation: { endfield: false } },
  });
  assert.equal(
    (await autoOff.runner.runEndfieldCheckinCycle()).stopReason,
    "disabled"
  );
  assert.equal(autoOff.calls.fetch.length, 0);
});

test("legacy storage without gameSettings still runs (migration defaults)", async () => {
  const { runner } = makeHarness({
    settings: { enabled: true, games: { genshin: false } },
    gameSettings: undefined,
  });
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.results.endfield, "success");
});

test("a risk-control answer latches until a manual run", async () => {
  const harness = makeHarness({
    attendance: {
      hasToday: false,
      claim: { code: 10003, message: "captcha verification required" },
    },
  });
  const first = await harness.runner.runEndfieldCheckinCycle();
  assert.equal(first.stopReason, "risk_control");
  assert.ok(harness.data.state.riskControl);

  const fetches = harness.calls.fetch.length;
  const second = await harness.runner.runEndfieldCheckinCycle();
  assert.equal(second.stopReason, "risk_control");
  assert.equal(harness.calls.fetch.length, fetches);

  const forced = await harness.runner.runEndfieldCheckinCycle({ force: true });
  assert.equal(forced.ran, true);
});

test("an account without an Endfield role logs no_role", async () => {
  const { runner, data } = makeHarness({ roles: [] });
  const summary = await runner.runEndfieldCheckinCycle();
  assert.equal(summary.results.endfield, "no_role");
  assert.equal(data.log.at(-1).outcome, "no_role");
});

test("refreshSanity reads the card without the automation switches", async () => {
  const { runner, data } = makeHarness({
    settings: { enabled: false, games: {} },
  });
  const result = await runner.refreshSanity();
  assert.equal(result.ok, true);
  assert.equal(result.sanity.current, 100);
  assert.equal(data.state.sanity.max, 240);

  const hidden = makeHarness({
    gameSettings: { display: { endfield: false } },
  });
  assert.deepEqual(await hidden.runner.refreshSanity(), {
    ok: false,
    reason: "hidden",
  });
});

test("refreshSanity reports unavailable when the card has no stamina shape", async () => {
  const { runner } = makeHarness({
    card: { status: 200, body: { code: 0, data: { something: "else" } } },
  });
  const result = await runner.refreshSanity();
  assert.deepEqual(result, { ok: false, reason: "unavailable" });
});

test("refreshSanity reads the real card/detail dungeon shape", async () => {
  // The live card/detail payload shape (data.detail.dungeon),
  // whose maxTs is the full-recovery instant in seconds.
  const maxTs = Math.floor(NOW.getTime() / 1000) + 3600;
  const { runner, data } = makeHarness({
    card: {
      status: 200,
      body: {
        code: 0,
        data: {
          detail: {
            dungeon: { curStamina: 90, maxStamina: 240, maxTs },
          },
        },
      },
    },
  });
  const result = await runner.refreshSanity();
  assert.equal(result.ok, true);
  assert.equal(result.sanity.current, 90);
  assert.equal(result.sanity.max, 240);
  assert.equal(result.sanity.fullAt, maxTs * 1000);
  assert.equal(result.sanity.estimated, false);
  assert.equal(data.state.sanity.current, 90);
});
