import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHoyolabCookieString,
  describeExchangeResult,
  isPairingTokenShape,
  selectHoyolabSessionCookies,
} from "../src/lib/hoyolab-cookie.mjs";

// The pure handoff logic: which cookies are picked, how they are
// serialized, and what the popup says for each API answer.

const cookie = (name, value, domain = ".hoyolab.com") => ({
  name,
  value,
  domain,
});

test("the required pair serializes in the fixed order", () => {
  const result = buildHoyolabCookieString([
    cookie("ltoken_v2", "tok"),
    cookie("ltuid_v2", "12345"),
    cookie("unrelated", "x"),
  ]);
  assert.equal(result, "ltuid_v2=12345; ltoken_v2=tok");
});

test("ltmid_v2 rides along when present", () => {
  const result = buildHoyolabCookieString([
    cookie("ltuid_v2", "12345"),
    cookie("ltoken_v2", "tok"),
    cookie("ltmid_v2", "mid"),
  ]);
  assert.equal(result, "ltuid_v2=12345; ltoken_v2=tok; ltmid_v2=mid");
});

test("a missing ltoken_v2 yields null", () => {
  assert.equal(buildHoyolabCookieString([cookie("ltuid_v2", "12345")]), null);
});

test("empty values do not count", () => {
  assert.equal(
    buildHoyolabCookieString([
      cookie("ltuid_v2", "12345"),
      cookie("ltoken_v2", ""),
    ]),
    null
  );
});

test("the parent-domain entry wins over host-only duplicates", () => {
  const selected = selectHoyolabSessionCookies([
    cookie("ltuid_v2", "host-only", "www.hoyolab.com"),
    cookie("ltuid_v2", "parent", ".hoyolab.com"),
    cookie("ltoken_v2", "tok"),
  ]);
  assert.equal(selected.get("ltuid_v2"), "parent");
});

test("v1 cookies are ignored", () => {
  assert.equal(
    buildHoyolabCookieString([cookie("ltuid", "1"), cookie("ltoken", "t")]),
    null
  );
});

test("pairing token shape accepts two base64url segments only", () => {
  assert.equal(isPairingTokenShape("abcDEF123_-.xyzABC-_"), true);
  assert.equal(isPairingTokenShape("  abc.def  "), true);
  assert.equal(isPairingTokenShape("abcdef"), false);
  assert.equal(isPairingTokenShape("a.b.c"), false);
  assert.equal(isPairingTokenShape(""), false);
});

test("exchange answers map to popup messages", () => {
  assert.equal(describeExchangeResult(200, { registered: true }).ok, true);
  assert.equal(describeExchangeResult(200, {}).ok, false);
  assert.equal(describeExchangeResult(401, { error: "x" }).ok, false);
  assert.match(
    describeExchangeResult(401, null).message,
    /ペアリングコード/
  );
  assert.match(describeExchangeResult(422, null).message, /HoYoLAB/);
  assert.equal(describeExchangeResult(503, null).ok, false);
});
