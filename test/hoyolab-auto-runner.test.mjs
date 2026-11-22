import assert from "node:assert/strict";
import test from "node:test";
import { createAutoRunner } from "../src/lib/hoyolab-auto-runner.mjs";

// The runner with faked dependencies: an in-memory store, a URL
// router standing in for the official APIs and hoyo-codes, a fixed
// clock, and a sleep that only records its calls. This exercises
// the full cycles — gating, role discovery, spacing, idempotency,
// family blocking, and the risk-control latch — with no network.

const NOW = new Date("2026-01-15T03:00:00Z"); // 12:00 JST, 11:00 UTC+8

function makeHarness(options = {}) {
  const data = {
    settings: options.settings ?? {
      enabled: true,
      games: { genshin: true, starrail: true, zzz: true },
    },
    records: options.records ?? {},
    state: options.state ?? {},
    log: [],
  };
  const calls = { fetch: [], sleep: [] };
  const codesByGame = options.codesByGame ?? { genshin: [], hkrpg: [], nap: [] };
  const rolesByBiz = options.rolesByBiz ?? {
    hk4e_global: [{ game_uid: "800000001", nickname: "旅人" }],
    hkrpg_global: [{ game_uid: "800000002", nickname: "開拓者" }],
    nap_global: [{ game_uid: "130000003", nickname: "プロキシ" }],
  };
  const exchangeResults = options.exchangeResults ?? {}; // code -> body or Error
  const signResults = options.signResults ?? {}; // sign url fragment -> body

  async function fetchJson(url, fetchOptions = {}) {
    calls.fetch.push(url);
    if (url.startsWith("https://hoyo-codes.seria.moe/codes")) {
      const game = new URL(url).searchParams.get("game");
      const codes = codesByGame[game];
      if (codes === null) throw new Error("network down");
      if (codes === undefined) return { status: 500, body: null };
      return {
        status: 200,
        body: {
          codes: codes.map((code, i) => ({
            id: i + 1,
            code,
            status: "OK",
            game,
            rewards: "",
          })),
          game,
        },
      };
    }
    if (url.includes("getAllRegions")) {
      return {
        status: 200,
        body: { retcode: 0, data: { list: [{ name: "Asia", region: "os_asia" }] } },
      };
    }
    if (url.includes("getUserGameRolesByLtoken")) {
      const biz = new URL(url).searchParams.get("game_biz");
      return {
        status: 200,
        body: { retcode: 0, data: { list: rolesByBiz[biz] ?? [] } },
      };
    }
    if (url.includes("webExchangeCdkeyHyl")) {
      const code = new URL(url).searchParams.get("cdkey");
      const result = exchangeResults[code] ?? { retcode: 0, message: "OK", data: {} };
      if (result instanceof Error) throw result;
      return { status: 200, body: result };
    }
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
    sleep: async (ms) => {
      calls.sleep.push(ms);
    },
    now: () => new Date(NOW),
    hasSession: async () => options.hasSession ?? true,
    loadData: async () => data,
    saveData: async (patch) => {
      Object.assign(data, patch);
    },
  });
  return { runner, data, calls };
}

const exchangeCalls = (calls) =>
  calls.fetch.filter((url) => url.includes("webExchangeCdkeyHyl"));
const signCalls = (calls) => calls.fetch.filter((url) => url.includes("/sign"));

// ---------------------------------------------------------- gating

test("nothing runs while the master switch is off", async () => {
  const { runner, calls } = makeHarness({
    settings: { enabled: false, games: { genshin: true, starrail: true, zzz: true } },
    codesByGame: { genshin: ["CODE1"], hkrpg: [], nap: [] },
  });
  const checkin = await runner.runCheckinCycle();
  const codes = await runner.runCodeCycle();
  assert.equal(checkin.ran, false);
  assert.equal(checkin.stopReason, "disabled");
  assert.equal(codes.ran, false);
  assert.equal(calls.fetch.length, 0);
});

test("a missing session stops the run and is surfaced in state", async () => {
  const { runner, data, calls } = makeHarness({ hasSession: false });
  const summary = await runner.runCheckinCycle();
  assert.equal(summary.stopReason, "not_logged_in");
  assert.equal(data.state.sessionMissing, true);
  assert.equal(calls.fetch.length, 0);
  assert.equal(data.log.at(-1).outcome, "not_logged_in");
});

test("games turned off individually are never contacted", async () => {
  const { runner, calls } = makeHarness({
    settings: { enabled: true, games: { genshin: true, starrail: false, zzz: false } },
    codesByGame: { genshin: [], hkrpg: ["HSRCODE"], nap: ["ZZZCODE"] },
  });
  await runner.runCodeCycle();
  assert.equal(
    calls.fetch.some((url) => url.includes("game=hkrpg")),
    false
  );
  assert.equal(
    calls.fetch.some((url) => url.includes("game=nap")),
    false
  );
});

// ---------------------------------------------------------- check-in

test("check-in claims every enabled game once per HoYoLAB day", async () => {
  const { runner, data, calls } = makeHarness();
  const first = await runner.runCheckinCycle();
  assert.equal(first.ran, true);
  assert.equal(signCalls(calls).length, 3);
  assert.equal(data.state.checkin.genshin.day, "2026-01-15");
  assert.equal(data.state.checkin.genshin.outcome, "success");

  const second = await runner.runCheckinCycle();
  assert.equal(signCalls(calls).length, 3); // no new calls
  assert.equal(second.results.genshin, "already_done");
});

test("an already-claimed answer also marks the day as done", async () => {
  const { runner, data } = makeHarness({
    signResults: { "event/sol": { retcode: -5003, message: "already", data: {} } },
  });
  const summary = await runner.runCheckinCycle();
  assert.equal(summary.results.genshin, "already_done");
  assert.equal(data.state.checkin.genshin.day, "2026-01-15");
});

// ---------------------------------------------------------- codes

test("new codes are redeemed once, spaced by the safety gap", async () => {
  const { runner, data, calls } = makeHarness({
    codesByGame: { genshin: ["CODEAAA", "CODEBBB"], hkrpg: [], nap: [] },
  });
  const summary = await runner.runCodeCycle();
  assert.equal(summary.games.genshin.attempted, 2);
  assert.deepEqual(calls.sleep, [5500]);
  assert.equal(data.records.genshin.CODEAAA.outcome, "success");
  assert.equal(data.records.genshin.CODEBBB.outcome, "success");
  const exchanges = exchangeCalls(calls);
  assert.match(exchanges[0], /game_biz=hk4e_global/);
  assert.match(exchanges[0], /uid=800000001/);
  assert.match(exchanges[0], /region=os_asia/);

  const again = await runner.runCodeCycle();
  assert.equal(again.games.genshin.attempted, 0);
  assert.equal(exchangeCalls(calls).length, 2);
});

test("a ZZZ family is closed by the first claim in the same cycle", async () => {
  const { runner, data, calls } = makeHarness({
    codesByGame: { genshin: [], hkrpg: [], nap: ["ZZZ25AAAA", "ZZZ25BBBB", "ZZZ26CCCC"] },
  });
  const summary = await runner.runCodeCycle();
  assert.equal(summary.games.zzz.attempted, 2);
  assert.equal(data.records.zzz.ZZZ25AAAA.outcome, "success");
  assert.equal(data.records.zzz.ZZZ25BBBB.outcome, "family_blocked");
  assert.equal(data.records.zzz.ZZZ26CCCC.outcome, "success");
  assert.equal(
    exchangeCalls(calls).some((url) => url.includes("ZZZ25BBBB")),
    false
  );
});

test("an unknown failure is retried once on the next cycle, then left", async () => {
  const results = { FLAKY: { retcode: -9999, message: "?", data: {} } };
  const { runner, data } = makeHarness({
    codesByGame: { genshin: ["FLAKY"], hkrpg: [], nap: [] },
    exchangeResults: results,
  });
  await runner.runCodeCycle();
  assert.equal(data.records.genshin.FLAKY.outcome, "failed");
  assert.equal(data.records.genshin.FLAKY.attempts, 1);

  await runner.runCodeCycle();
  assert.equal(data.records.genshin.FLAKY.attempts, 2);

  const third = await runner.runCodeCycle();
  assert.equal(third.games.genshin.attempted, 0);
});

test("a failed code fetch skips the game without recording anything", async () => {
  const { runner, data } = makeHarness({
    codesByGame: { genshin: null, hkrpg: [], nap: [] },
  });
  const summary = await runner.runCodeCycle();
  assert.equal(summary.games.genshin.fetchFailed, true);
  assert.equal(data.records.genshin, undefined);
  assert.equal(data.log.at(-1).outcome, "fetch_failed");
});

test("a game without a character is skipped with a log entry", async () => {
  const { runner, data, calls } = makeHarness({
    codesByGame: { genshin: ["CODEAAA"], hkrpg: [], nap: [] },
    rolesByBiz: { hk4e_global: [] },
  });
  const summary = await runner.runCodeCycle();
  assert.equal(summary.games.genshin.noRole, true);
  assert.equal(exchangeCalls(calls).length, 0);
  assert.equal(
    data.log.some((entry) => entry.outcome === "no_role"),
    true
  );
});

test("terminal answers are recorded and never retried", async () => {
  const { runner, data } = makeHarness({
    codesByGame: { genshin: ["OLDCODE", "GONECODE"], hkrpg: [], nap: [] },
    exchangeResults: {
      OLDCODE: { retcode: -2017, message: "already", data: {} },
      GONECODE: { retcode: -2001, message: "expired", data: {} },
    },
  });
  await runner.runCodeCycle();
  assert.equal(data.records.genshin.OLDCODE.outcome, "already_used");
  assert.equal(data.records.genshin.GONECODE.outcome, "expired");
  const again = await runner.runCodeCycle();
  assert.equal(again.games.genshin.attempted, 0);
});

// ---------------------------------------------------------- risk control

test("a risk-control answer latches the stop until a manual run", async () => {
  const results = {
    FIRSTCODE: {
      retcode: -3101,
      message: "risk",
      data: { gt: "x", challenge: "y" },
    },
  };
  const { runner, data, calls } = makeHarness({
    codesByGame: { genshin: ["FIRSTCODE"], hkrpg: ["HSRCODE"], nap: [] },
    exchangeResults: results,
  });
  const summary = await runner.runCodeCycle();
  assert.equal(summary.stopReason, "risk_control");
  assert.equal(data.state.riskControl.game, "genshin");
  // The starrail code was never attempted after the stop.
  assert.equal(
    exchangeCalls(calls).some((url) => url.includes("HSRCODE")),
    false
  );

  const blocked = await runner.runCodeCycle();
  assert.equal(blocked.stopReason, "risk_control");
  assert.equal(blocked.ran, false);

  // The user verifies manually, then presses "run now": the latch
  // clears and the same code goes through.
  results.FIRSTCODE = { retcode: 0, message: "OK", data: {} };
  const forced = await runner.runCodeCycle({ force: true });
  assert.equal(forced.ran, true);
  assert.equal(data.state.riskControl, null);
  assert.equal(data.records.genshin.FIRSTCODE.outcome, "success");
});
