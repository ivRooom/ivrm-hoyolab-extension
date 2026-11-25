import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";
import {
  buildSkportHeaders,
  classifySkportResponse,
  computeSkportSign,
  describeSkportFailureDetail,
  estimateSanityFullAt,
  extractSanity,
  isEndfieldCheckinDue,
  md5Hex,
  nextEndfieldAlarmTime,
  parseAttendanceStatus,
  parseBindingRoles,
  parseClaimRewards,
  skportDateKey,
  skportHeaderJson,
  skportSignMessage,
} from "../src/lib/skport.mjs";

// The pure Skport logic: the MD5 implementation, the request
// signature (verified against node:crypto), response parsing and
// classification, the best-effort sanity extraction, and the
// 04:00 UTC+8 day boundary. No network, no chrome.* APIs.

// ---------------------------------------------------------- md5

test("md5 matches the RFC 1321 test suite", () => {
  assert.equal(md5Hex(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5Hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(
    md5Hex("The quick brown fox jumps over the lazy dog"),
    "9e107d9d372bb6826bd81d3542a419d6"
  );
  // 80 bytes: exercises the multi-block path.
  assert.equal(
    md5Hex("1234567890".repeat(8)),
    "57edf4a22be3c955ac49da2e2107b67a"
  );
});

// ---------------------------------------------------------- signing

test("the header JSON is byte-for-byte the reference shape", () => {
  assert.equal(
    skportHeaderJson("1700000000"),
    '{"platform":"3","timestamp":"1700000000","dId":"","vName":"1.0.0"}'
  );
  assert.equal(
    skportSignMessage("/web/v1/game/endfield/attendance", "", "1700000000"),
    '/web/v1/game/endfield/attendance1700000000{"platform":"3","timestamp":"1700000000","dId":"","vName":"1.0.0"}'
  );
});

test("the signature is MD5 of the hex HMAC-SHA256 of the message", async () => {
  const hmacSha256Hex = async (key, message) =>
    createHmac("sha256", key).update(message).digest("hex");
  const sign = await computeSkportSign(
    {
      path: "/web/v1/game/endfield/attendance",
      body: "",
      timestamp: "1700000000",
      signToken: "test-token",
    },
    { hmacSha256Hex }
  );
  const expected = createHash("md5")
    .update(
      createHmac("sha256", "test-token")
        .update(
          '/web/v1/game/endfield/attendance1700000000{"platform":"3","timestamp":"1700000000","dId":"","vName":"1.0.0"}'
        )
        .digest("hex")
    )
    .digest("hex");
  assert.equal(sign, expected);
});

test("signed headers carry cred, platform, timestamp, sign and the game role", () => {
  const headers = buildSkportHeaders({
    cred: "CRED",
    timestamp: "1700000000",
    sign: "SIGN",
    gameRole: "3_12345_5",
  });
  assert.equal(headers.cred, "CRED");
  assert.equal(headers.platform, "3");
  assert.equal(headers.vName, "1.0.0");
  assert.equal(headers.timestamp, "1700000000");
  assert.equal(headers.sign, "SIGN");
  assert.equal(headers["sk-game-role"], "3_12345_5");
  const bare = buildSkportHeaders({ cred: "CRED", timestamp: "1" });
  assert.equal(bare.sign, undefined);
  assert.equal(bare["sk-game-role"], undefined);
});

// ---------------------------------------------------------- parsing

test("binding answers flatten into Endfield roles only", () => {
  const roles = parseBindingRoles({
    code: 0,
    data: {
      list: [
        {
          appCode: "arknights",
          bindingList: [{ roles: [{ roleId: 1, serverId: 1 }] }],
        },
        {
          appCode: "endfield",
          bindingList: [
            {
              roles: [
                {
                  roleId: 12345,
                  serverId: 5,
                  nickname: "博士",
                  level: 10,
                  serverName: "Asia",
                },
                { roleId: "678", serverId: "5", nickname: "副官" },
              ],
            },
            { roles: [] },
          ],
        },
      ],
    },
  });
  assert.deepEqual(roles, [
    {
      gameRole: "3_12345_5",
      roleId: "12345",
      serverId: "5",
      nickname: "博士",
      level: 10,
      serverName: "Asia",
    },
    {
      gameRole: "3_678_5",
      roleId: "678",
      serverId: "5",
      nickname: "副官",
      level: null,
      serverName: "",
    },
  ]);
  assert.equal(parseBindingRoles({ code: 1, data: {} }), null);
  assert.equal(parseBindingRoles(null), null);
  assert.deepEqual(parseBindingRoles({ code: 0, data: { list: [] } }), []);
});

test("attendance status and claim rewards parse", () => {
  assert.deepEqual(
    parseAttendanceStatus({ code: 0, data: { hasToday: true } }),
    { hasToday: true }
  );
  assert.equal(parseAttendanceStatus({ code: 0, data: {} }), null);
  assert.equal(parseAttendanceStatus({ code: 10001, data: {} }), null);
  assert.deepEqual(
    parseClaimRewards({
      code: 0,
      data: {
        awardIds: [{ id: "a1" }, { id: "a2" }],
        resourceInfoMap: { a1: { name: "折金票", count: 500 } },
      },
    }),
    ["折金票 x500", "a2"]
  );
  assert.equal(parseClaimRewards({ code: 1 }), null);
});

// ---------------------------------------------------------- classify

test("Skport codes classify into the shared outcome vocabulary", () => {
  assert.equal(classifySkportResponse(200, { code: 0 }), "success");
  assert.equal(classifySkportResponse(200, { code: 10001 }), "already_done");
  // 10001 can arrive with HTTP 403 and still means already signed.
  assert.equal(classifySkportResponse(403, { code: 10001 }), "already_done");
  assert.equal(classifySkportResponse(429, { code: 0 }), "rate_limited");
  assert.equal(classifySkportResponse(401, { code: 10002 }), "not_logged_in");
  assert.equal(
    classifySkportResponse(200, { code: 10002, message: "token expired" }),
    "not_logged_in"
  );
  assert.equal(
    classifySkportResponse(200, { code: 10003, message: "captcha required" }),
    "risk_control"
  );
  assert.equal(classifySkportResponse(200, { code: 9999 }), "failed");
  assert.equal(classifySkportResponse(500, null), "failed");
});

test("failure details carry only the code and the message", () => {
  assert.equal(
    describeSkportFailureDetail({ code: 10001, message: "already signed" }),
    "code 10001: already signed"
  );
  assert.equal(describeSkportFailureDetail({ code: 7 }), "code 7");
  assert.equal(describeSkportFailureDetail(null), "");
  assert.equal(describeSkportFailureDetail({ data: {} }), "");
  assert.equal(
    describeSkportFailureDetail({ message: "a\nb" }),
    "ab"
  );
});

// ---------------------------------------------------------- sanity

test("sanity extraction finds the stamina shape at the documented nests", () => {
  assert.deepEqual(
    extractSanity({ code: 0, data: { stamina: { current: 10, max: 240 } } }),
    { current: 10, max: 240, recoveryTime: null }
  );
  assert.deepEqual(
    extractSanity({
      code: 0,
      data: { card: { detail: { sanity: { current: 5, max: 125, recoveryTime: 42 } } } },
    }),
    { current: 5, max: 125, recoveryTime: 42 }
  );
  assert.equal(extractSanity({ code: 0, data: {} }), null);
  assert.equal(extractSanity(null), null);
  assert.equal(
    extractSanity({ data: { stamina: { current: "10", max: 240 } } }),
    null
  );
});

test("sanity extraction reads the real card/detail dungeon shape", () => {
  // The live card/detail payload, as documented from the real
  // API by yeci226/endfield-discord-bot: stamina lives at
  // data.detail.dungeon as curStamina/maxStamina, and maxTs is
  // the instant stamina reaches max (carried as recoveryTime).
  assert.deepEqual(
    extractSanity({
      code: 0,
      data: {
        detail: {
          dungeon: { curStamina: 87, maxStamina: 240, maxTs: 1768600000 },
        },
      },
    }),
    { current: 87, max: 240, recoveryTime: 1768600000 }
  );
  // A dungeon block without maxTs still yields the reading.
  assert.deepEqual(
    extractSanity({
      code: 0,
      data: { detail: { dungeon: { curStamina: 0, maxStamina: 240 } } },
    }),
    { current: 0, max: 240, recoveryTime: null }
  );
  // Non-numeric or degenerate dungeon values are not a reading.
  assert.equal(
    extractSanity({
      data: { detail: { dungeon: { curStamina: "87", maxStamina: 240 } } },
    }),
    null
  );
  assert.equal(
    extractSanity({
      data: { detail: { dungeon: { curStamina: 87, maxStamina: 0 } } },
    }),
    null
  );
});

test("full-recovery estimates prefer the card's recoveryTime", () => {
  const now = Date.parse("2026-01-15T00:00:00Z");
  // Already full.
  assert.deepEqual(estimateSanityFullAt({ current: 240, max: 240 }, now), {
    fullAt: now,
    estimated: false,
  });
  // Seconds epoch.
  assert.deepEqual(
    estimateSanityFullAt(
      { current: 0, max: 240, recoveryTime: now / 1000 + 3600 },
      now
    ),
    { fullAt: now + 3600_000, estimated: false }
  );
  // Remaining seconds.
  assert.deepEqual(
    estimateSanityFullAt({ current: 0, max: 240, recoveryTime: 7200 }, now),
    { fullAt: now + 7200_000, estimated: false }
  );
  // Fallback: (240 - 140) points at 432 s each, flagged estimated.
  assert.deepEqual(
    estimateSanityFullAt({ current: 140, max: 240, recoveryTime: null }, now),
    { fullAt: now + 100 * 432_000, estimated: true }
  );
});

// ---------------------------------------------------------- schedule

test("the Skport day starts at 04:00 UTC+8", () => {
  // 2026-01-15 03:59 UTC+8 is still the Jan 14 Skport day.
  assert.equal(
    skportDateKey(new Date("2026-01-14T19:59:00Z")),
    "2026-01-14"
  );
  // 2026-01-15 04:00 UTC+8 sharp opens Jan 15.
  assert.equal(
    skportDateKey(new Date("2026-01-14T20:00:00Z")),
    "2026-01-15"
  );
  // Midday JST is the same calendar day.
  assert.equal(
    skportDateKey(new Date("2026-01-15T03:00:00Z")),
    "2026-01-15"
  );
});

test("the next Endfield alarm is the next 05:05 JST", () => {
  const morning = new Date("2026-01-01T00:00:00Z"); // 09:00 JST
  assert.equal(
    nextEndfieldAlarmTime(morning),
    new Date("2026-01-01T20:05:00Z").getTime() // Jan 2, 05:05 JST
  );
  const justAfter = new Date("2026-01-01T20:06:00Z"); // Jan 2, 05:06 JST
  assert.equal(
    nextEndfieldAlarmTime(justAfter),
    new Date("2026-01-02T20:05:00Z").getTime() // Jan 3, 05:05 JST
  );
});

test("check-in is due only when the current Skport day is unclaimed", () => {
  const now = new Date("2026-01-15T03:00:00Z");
  assert.equal(isEndfieldCheckinDue({}, now), true);
  assert.equal(
    isEndfieldCheckinDue(
      { checkin: { endfield: { day: "2026-01-15" } } },
      now
    ),
    false
  );
  assert.equal(
    isEndfieldCheckinDue(
      { checkin: { endfield: { day: "2026-01-14" } } },
      now
    ),
    true
  );
});
