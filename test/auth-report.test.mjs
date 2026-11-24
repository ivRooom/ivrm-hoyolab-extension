import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_STATE_REPORT_URL,
  applyReportedStatus,
  normalizeReportedState,
  pendingAuthReports,
  postAuthState,
  syncAuthReports,
} from "../src/lib/auth-report.mjs";

// Auth-state reporting to the portal (ivrm-web #1684, slice S2):
// transitions of the shared login state (#10) are mirrored to
// the portal exactly once each, fail-soft, with the pairing
// token as the only credential. background.js wires storage and
// the real fetch around syncAuthReports; these tests drive the
// pure module with a fake fetch.

const TOKEN = "member-uuid.signature";

function authState(hoyolab = "ok", skport = "ok") {
  return {
    hoyolab: { status: hoyolab, since: null, notified: false },
    skport: { status: skport, since: null, notified: false },
  };
}

// A fake fetch that records calls and answers from a script:
// each entry is a status number, or "throw" for a network error.
function makeFetch(script = []) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const next = script.length > 0 ? script.shift() : 200;
    if (next === "throw") throw new Error("network down");
    return { status: next };
  };
  return { fetchFn, calls };
}

// ---------------------------------------------------------- pending computation

test("nothing acknowledged yet: both current states are pending", () => {
  assert.deepEqual(pendingAuthReports(authState(), undefined), [
    { provider: "hoyolab", status: "ok" },
    { provider: "skport", status: "ok" },
  ]);
  assert.deepEqual(normalizeReportedState(undefined), {
    hoyolab: null,
    skport: null,
  });
  // Malformed stored values are not trusted.
  assert.deepEqual(normalizeReportedState({ hoyolab: "gone" }), {
    hoyolab: null,
    skport: null,
  });
});

test("only the provider whose status moved is pending", () => {
  const reported = { hoyolab: "expired", skport: "ok" };
  assert.deepEqual(pendingAuthReports(authState("ok", "ok"), reported), [
    { provider: "hoyolab", status: "ok" },
  ]);
  assert.deepEqual(pendingAuthReports(authState("ok", "ok"), {
    hoyolab: "ok",
    skport: "ok",
  }), []);
});

// ---------------------------------------------------------- one POST per transition

test("a transition triggers exactly one POST with the contract body", async () => {
  const { fetchFn, calls } = makeFetch([200]);
  const result = await syncAuthReports({
    fetchFn,
    token: TOKEN,
    authState: authState("expired", "ok"),
    reportedState: { hoyolab: "ok", skport: "ok" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, AUTH_STATE_REPORT_URL);
  assert.equal(calls[0].url, "https://api.ivrm.jp/member/hoyolab/auth-state");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    provider: "hoyolab",
    status: "expired",
  });
  assert.deepEqual(result.attempted, [{ provider: "hoyolab", status: "expired" }]);
  assert.deepEqual(result.delivered, [{ provider: "hoyolab", status: "expired" }]);
  assert.deepEqual(result.reported, { hoyolab: "expired", skport: "ok" });
});

test("a recovery (expired -> ok) is a transition and is reported too", async () => {
  const { fetchFn, calls } = makeFetch([200]);
  const result = await syncAuthReports({
    fetchFn,
    token: TOKEN,
    authState: authState("ok", "expired"),
    reportedState: { hoyolab: "expired", skport: "expired" },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    provider: "hoyolab",
    status: "ok",
  });
  assert.deepEqual(result.reported, { hoyolab: "ok", skport: "expired" });
});

// ---------------------------------------------------------- no token, no report

test("without a token nothing is fetched and nothing is acknowledged", async () => {
  for (const token of [undefined, null, ""]) {
    const { fetchFn, calls } = makeFetch();
    const result = await syncAuthReports({
      fetchFn,
      token,
      authState: authState("expired", "expired"),
      reportedState: undefined,
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(result.attempted, []);
    assert.deepEqual(result.reported, { hoyolab: null, skport: null });
  }
});

// ---------------------------------------------------------- fail-soft

test("failures never throw and leave the acknowledged state untouched", async () => {
  for (const script of [["throw"], [404], [401], [500]]) {
    const { fetchFn, calls } = makeFetch(script);
    const result = await syncAuthReports({
      fetchFn,
      token: TOKEN,
      authState: authState("expired", "ok"),
      reportedState: { hoyolab: "ok", skport: "ok" },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.delivered, []);
    assert.deepEqual(result.reported, { hoyolab: "ok", skport: "ok" });
  }
  // postAuthState itself classifies rather than throwing.
  await assert.doesNotReject(() =>
    postAuthState(async () => {
      throw new Error("down");
    }, TOKEN, "hoyolab", "expired")
  );
});

test("a failed report is retried once by the next sync, then lands", async () => {
  const { fetchFn, calls } = makeFetch([503, 200]);
  const input = {
    fetchFn,
    token: TOKEN,
    authState: authState("expired", "ok"),
    reportedState: { hoyolab: "ok", skport: "ok" },
  };
  const first = await syncAuthReports(input);
  assert.equal(calls.length, 1);
  assert.deepEqual(first.reported, { hoyolab: "ok", skport: "ok" });

  const second = await syncAuthReports({
    ...input,
    reportedState: first.reported,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(second.reported, { hoyolab: "expired", skport: "ok" });
});

test("after a successful report, later syncs without a transition stay silent", async () => {
  const { fetchFn, calls } = makeFetch();
  const first = await syncAuthReports({
    fetchFn,
    token: TOKEN,
    authState: authState("expired", "ok"),
    reportedState: { hoyolab: "ok", skport: "ok" },
  });
  assert.equal(calls.length, 1);
  for (let i = 0; i < 3; i += 1) {
    const again = await syncAuthReports({
      fetchFn,
      token: TOKEN,
      authState: authState("expired", "ok"),
      reportedState: first.reported,
    });
    assert.deepEqual(again.attempted, []);
  }
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------- pairing baseline

test("pairing-time baseline: the known states are reported once when a token appears", async () => {
  const { fetchFn, calls } = makeFetch([200, 200]);
  const result = await syncAuthReports({
    fetchFn,
    token: TOKEN,
    authState: authState("ok", "expired"),
    reportedState: undefined,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.init.body)),
    [
      { provider: "hoyolab", status: "ok" },
      { provider: "skport", status: "expired" },
    ]
  );
  assert.deepEqual(result.reported, { hoyolab: "ok", skport: "expired" });

  // The baseline is a one-off: the next sync has nothing to say.
  const again = await syncAuthReports({
    fetchFn,
    token: TOKEN,
    authState: authState("ok", "expired"),
    reportedState: result.reported,
  });
  assert.deepEqual(again.attempted, []);
  assert.equal(calls.length, 2);
});

test("a partial baseline failure keeps only the failed provider pending", async () => {
  const { fetchFn, calls } = makeFetch([200, "throw"]);
  const result = await syncAuthReports({
    fetchFn,
    token: TOKEN,
    authState: authState("expired", "expired"),
    reportedState: undefined,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.reported, { hoyolab: "expired", skport: null });
  assert.deepEqual(
    pendingAuthReports(authState("expired", "expired"), result.reported),
    [{ provider: "skport", status: "expired" }]
  );
});

test("applyReportedStatus folds one acknowledgement at a time", () => {
  let reported = applyReportedStatus(undefined, "skport", "expired");
  assert.deepEqual(reported, { hoyolab: null, skport: "expired" });
  reported = applyReportedStatus(reported, "hoyolab", "ok");
  assert.deepEqual(reported, { hoyolab: "ok", skport: "expired" });
  // Unknown providers and statuses are ignored, not stored.
  assert.deepEqual(applyReportedStatus(reported, "other", "ok"), reported);
  assert.deepEqual(applyReportedStatus(reported, "hoyolab", "gone"), {
    hoyolab: null,
    skport: "expired",
  });
});
