import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAutoLog,
  applyRedeemResult,
  classifyExchangeResponse,
  classifySignResponse,
  countSuccessfulRedeems,
  defaultAutoSettings,
  enabledGameIds,
  familyKeyFor,
  hoyolabDateKey,
  isCheckinDue,
  isRedeemableRecord,
  nextCheckinAlarmTime,
  normalizeAutoSettings,
  parseHoyoCodesResponse,
  planRedeemAttempts,
} from "../src/lib/hoyolab-auto.mjs";

// The pure automation logic: hoyo-codes parsing, response
// classification, idempotency and family rules, and the check-in
// schedule. No network, no chrome.* APIs.

// ---------------------------------------------------------- codes

test("hoyo-codes answers parse into clean code entries", () => {
  const parsed = parseHoyoCodesResponse({
    codes: [
      { id: 1, code: "genshingift", status: "OK", game: "genshin", rewards: "" },
      { id: 2, code: "ABC123", status: "OK", game: "genshin", rewards: "プリモジェム×60" },
      { id: 3, code: "ABC123", status: "OK", game: "genshin", rewards: "" },
      { id: 4, code: "DEAD", status: "NOT_OK", game: "genshin", rewards: "" },
      { id: 5, code: "  ", status: "OK", game: "genshin", rewards: "" },
      { id: 6, status: "OK", game: "genshin", rewards: "" },
    ],
    game: "genshin",
  });
  assert.deepEqual(parsed, [
    { code: "GENSHINGIFT", rewards: "" },
    { code: "ABC123", rewards: "プリモジェム×60" },
  ]);
});

test("a payload without a codes array is a failed fetch", () => {
  assert.equal(parseHoyoCodesResponse(null), null);
  assert.equal(parseHoyoCodesResponse({}), null);
  assert.equal(parseHoyoCodesResponse({ codes: "nope" }), null);
  assert.deepEqual(parseHoyoCodesResponse({ codes: [] }), []);
});

// ---------------------------------------------------------- family

test("family keys follow the hoyo-codes ZZZ rule", () => {
  assert.equal(familyKeyFor("zzz", "ZZZ25ABCDE"), "ZZZ25");
  assert.equal(familyKeyFor("zzz", "ZZZ24XYZ"), "ZZZ24");
  assert.equal(familyKeyFor("zzz", "ZZZAB12345"), null);
  assert.equal(familyKeyFor("zzz", "ZENLESSGIFT"), null);
  assert.equal(familyKeyFor("zzz", "ZZZ2"), null);
  assert.equal(familyKeyFor("genshin", "ZZZ25ABCDE"), null);
  assert.equal(familyKeyFor("starrail", "ZZZ25ABCDE"), null);
});

// ---------------------------------------------------------- records

test("terminal outcomes are never attempted again", () => {
  for (const outcome of [
    "success",
    "already_used",
    "used_by_others",
    "expired",
    "invalid",
    "usage_limit",
    "level_insufficient",
    "family_blocked",
  ]) {
    assert.equal(isRedeemableRecord({ outcome, attempts: 1 }), false, outcome);
  }
  assert.equal(isRedeemableRecord(undefined), true);
  assert.equal(isRedeemableRecord({ outcome: "failed", attempts: 1 }), true);
  assert.equal(isRedeemableRecord({ outcome: "failed", attempts: 2 }), false);
});

test("planning skips recorded codes and blocks consumed families", () => {
  const records = {
    zzz: {
      OLDCODE1: { outcome: "success", at: 1, attempts: 1 },
      ZZZ25TAKEN: { outcome: "success", at: 1, attempts: 1 },
      FAILEDONCE: { outcome: "failed", at: 1, attempts: 1 },
      FAILEDTWICE: { outcome: "failed", at: 1, attempts: 2 },
    },
  };
  const codes = [
    { code: "OLDCODE1", rewards: "" },
    { code: "ZZZ25OTHER", rewards: "" },
    { code: "FAILEDONCE", rewards: "" },
    { code: "FAILEDTWICE", rewards: "" },
    { code: "BRANDNEW", rewards: "" },
  ];
  const plan = planRedeemAttempts("zzz", codes, records);
  assert.deepEqual(
    plan.toAttempt.map((entry) => entry.code),
    ["FAILEDONCE", "BRANDNEW"]
  );
  assert.deepEqual(
    plan.familyBlocked.map((entry) => entry.code),
    ["ZZZ25OTHER"]
  );
});

test("a claim marks family siblings as blocked, failures do not", () => {
  const known = ["ZZZ25AAAA", "ZZZ25BBBB", "ZZZ26CCCC", "OTHER"];
  let records = applyRedeemResult({}, "zzz", "ZZZ25AAAA", "success", 100, known);
  assert.equal(records.zzz.ZZZ25AAAA.outcome, "success");
  assert.equal(records.zzz.ZZZ25BBBB.outcome, "family_blocked");
  assert.equal(records.zzz.ZZZ26CCCC, undefined);
  assert.equal(records.zzz.OTHER, undefined);

  records = applyRedeemResult({}, "zzz", "ZZZ25AAAA", "failed", 100, known);
  assert.equal(records.zzz.ZZZ25BBBB, undefined);
  assert.equal(records.zzz.ZZZ25AAAA.attempts, 1);

  records = applyRedeemResult(records, "zzz", "ZZZ25AAAA", "failed", 200, known);
  assert.equal(records.zzz.ZZZ25AAAA.attempts, 2);
});

test("already_used also consumes the family slot", () => {
  const records = applyRedeemResult(
    {},
    "zzz",
    "ZZZ25AAAA",
    "already_used",
    100,
    ["ZZZ25AAAA", "ZZZ25BBBB"]
  );
  assert.equal(records.zzz.ZZZ25BBBB.outcome, "family_blocked");
});

test("successful redeems are counted in total and per JST month", () => {
  const jan15 = new Date("2026-01-15T03:00:00Z").getTime(); // 12:00 JST
  const dec31 = new Date("2025-12-31T03:00:00Z").getTime(); // 12:00 JST
  const records = {
    genshin: {
      A: { outcome: "success", at: jan15, attempts: 1 },
      B: { outcome: "success", at: dec31, attempts: 1 },
      C: { outcome: "expired", at: jan15, attempts: 1 },
    },
    zzz: { D: { outcome: "success", at: jan15, attempts: 1 } },
  };
  assert.equal(countSuccessfulRedeems(records), 3);
  assert.equal(countSuccessfulRedeems(records, "2026-01"), 2);
  assert.equal(countSuccessfulRedeems(records, "2025-12"), 1);
});

// ---------------------------------------------------------- classify

test("exchange retcodes classify per the verified table", () => {
  const ok = (retcode, message = "") => ({ retcode, message, data: {} });
  assert.equal(classifyExchangeResponse(200, ok(0, "OK")), "success");
  assert.equal(classifyExchangeResponse(200, ok(-2001)), "expired");
  assert.equal(classifyExchangeResponse(200, ok(-2003)), "invalid");
  assert.equal(classifyExchangeResponse(200, ok(-2006)), "usage_limit");
  assert.equal(classifyExchangeResponse(200, ok(-2011)), "level_insufficient");
  assert.equal(classifyExchangeResponse(200, ok(-2017)), "already_used");
  assert.equal(classifyExchangeResponse(200, ok(-2018)), "used_by_others");
  assert.equal(classifyExchangeResponse(200, ok(-100)), "not_logged_in");
  assert.equal(classifyExchangeResponse(200, ok(10101)), "rate_limited");
  assert.equal(classifyExchangeResponse(429, null), "rate_limited");
  assert.equal(classifyExchangeResponse(200, ok(-9999)), "failed");
  assert.equal(classifyExchangeResponse(500, null), "failed");
  assert.equal(classifyExchangeResponse(200, null), "failed");
});

test("a verification payload classifies as risk control", () => {
  const body = {
    retcode: -100,
    message: "Account is at risk",
    data: { gt: "abc", challenge: "def" },
  };
  // -100 alone would be "not logged in"; the risk payload wins only
  // when the retcode is not the plain login one. Use a neutral
  // retcode here to isolate the payload signal.
  assert.equal(
    classifyExchangeResponse(200, { ...body, retcode: -3101 }),
    "risk_control"
  );
  assert.equal(
    classifySignResponse(200, {
      retcode: 0,
      message: "OK",
      data: { is_risk: true },
    }),
    "risk_control"
  );
});

test("sign retcodes classify success, already done, and login loss", () => {
  const ok = (retcode, message = "") => ({ retcode, message, data: {} });
  assert.equal(classifySignResponse(200, ok(0, "OK")), "success");
  assert.equal(classifySignResponse(200, ok(-5003)), "already_done");
  assert.equal(classifySignResponse(200, ok(-100)), "not_logged_in");
  assert.equal(classifySignResponse(200, ok(-1)), "failed");
});

// ---------------------------------------------------------- schedule

test("the HoYoLAB day is the UTC+8 calendar date", () => {
  // 2026-01-01 15:59 UTC = 23:59 UTC+8, still Jan 1 there.
  assert.equal(hoyolabDateKey(new Date("2026-01-01T15:59:00Z")), "2026-01-01");
  // 2026-01-01 16:30 UTC = 2026-01-02 00:30 UTC+8 (01:30 JST).
  assert.equal(hoyolabDateKey(new Date("2026-01-01T16:30:00Z")), "2026-01-02");
});

test("the next check-in alarm is the next 01:05 JST", () => {
  const morning = new Date("2026-01-01T00:00:00Z"); // 09:00 JST
  assert.equal(
    nextCheckinAlarmTime(morning),
    new Date("2026-01-01T16:05:00Z").getTime() // Jan 2, 01:05 JST
  );
  const justAfter = new Date("2026-01-01T16:06:00Z"); // Jan 2, 01:06 JST
  assert.equal(
    nextCheckinAlarmTime(justAfter),
    new Date("2026-01-02T16:05:00Z").getTime() // Jan 3, 01:05 JST
  );
  const exactly = new Date("2026-01-01T16:05:00Z"); // Jan 2, 01:05 JST sharp
  assert.equal(
    nextCheckinAlarmTime(exactly),
    new Date("2026-01-02T16:05:00Z").getTime()
  );
});

test("check-in is due only when today's HoYoLAB day is unclaimed", () => {
  const now = new Date("2026-01-15T03:00:00Z");
  assert.equal(isCheckinDue({}, "genshin", now), true);
  assert.equal(
    isCheckinDue(
      { checkin: { genshin: { day: "2026-01-15", outcome: "success" } } },
      "genshin",
      now
    ),
    false
  );
  assert.equal(
    isCheckinDue(
      { checkin: { genshin: { day: "2026-01-14", outcome: "success" } } },
      "genshin",
      now
    ),
    true
  );
});

// ---------------------------------------------------------- settings & log

test("settings normalize to the opt-in defaults", () => {
  assert.deepEqual(normalizeAutoSettings(undefined), defaultAutoSettings());
  assert.deepEqual(normalizeAutoSettings("junk"), defaultAutoSettings());
  assert.deepEqual(
    normalizeAutoSettings({ enabled: true, games: { zzz: false } }),
    { enabled: true, games: { genshin: true, starrail: true, zzz: false } }
  );
  assert.deepEqual(enabledGameIds(defaultAutoSettings()), []);
  assert.deepEqual(
    enabledGameIds({ enabled: true, games: { genshin: true, starrail: false, zzz: true } }),
    ["genshin", "zzz"]
  );
});

test("the run log is capped at the newest entries", () => {
  let log = [];
  for (let i = 0; i < 120; i += 1) {
    log = appendAutoLog(log, { at: i, kind: "redeem", outcome: "success" });
  }
  assert.equal(log.length, 100);
  assert.equal(log[0].at, 20);
  assert.equal(log.at(-1).at, 119);
});
