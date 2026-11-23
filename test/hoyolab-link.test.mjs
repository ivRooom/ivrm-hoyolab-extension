import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLinkSummaryRows,
  fetchLinkSummary,
  formatRelativeTime,
  LINK_SUMMARY_URL,
  pickLinkSummaryUpdatedAt,
  summaryBarPercent,
} from "../src/lib/hoyolab-link.mjs";

// #3 (ivrm-web #1675): the popup's "current status" section. The
// properties that matter: rows come only from data the portal
// actually returned, a 401 is told apart from other failures (it
// means "link again"), and the request carries the stored token
// as a Bearer header to the one summary URL.

const fullBody = {
  ok: true,
  games: {
    genshin: { resinCurrent: 120, resinMax: 200, explorationPercent: 70.5 },
    starrail: {
      trailblazeCurrent: 240,
      trailblazeMax: 240,
      explorationPercent: null,
    },
  },
  updatedAt: {
    notes: "2026-11-23T10:00:00.000Z",
    progress: "2026-11-23T09:00:00.000Z",
  },
};

test("rows are built per game with bar percent and exploration", () => {
  assert.deepEqual(buildLinkSummaryRows(fullBody), [
    {
      id: "genshin",
      label: "原神",
      icon: "icon-genshin.png",
      metricLabel: "樹脂",
      current: 120,
      max: 200,
      percent: 60,
      explorationPercent: 70.5,
    },
    {
      id: "starrail",
      label: "崩壊：スターレイル",
      icon: "icon-starrail.png",
      metricLabel: "開拓力",
      current: 240,
      max: 240,
      percent: 100,
      explorationPercent: null,
    },
  ]);
});

test("unregistered games and incomplete pairs are skipped", () => {
  const rows = buildLinkSummaryRows({
    ok: true,
    games: {
      genshin: null,
      starrail: {
        trailblazeCurrent: null,
        trailblazeMax: 240,
        explorationPercent: null,
      },
    },
    updatedAt: { notes: null, progress: null },
  });
  assert.deepEqual(rows, []);
});

test("a non-ok body yields no rows", () => {
  assert.deepEqual(buildLinkSummaryRows(null), []);
  assert.deepEqual(buildLinkSummaryRows({ ok: false }), []);
  assert.deepEqual(buildLinkSummaryRows({ ok: true, games: null }), []);
});

test("bar percent clamps and rejects unusable pairs", () => {
  assert.equal(summaryBarPercent(300, 200), 100);
  assert.equal(summaryBarPercent(-5, 200), 0);
  assert.equal(summaryBarPercent(10, 0), null);
  assert.equal(summaryBarPercent(null, 200), null);
  assert.equal(summaryBarPercent(10, null), null);
});

test("the fresher update stamp wins", () => {
  assert.equal(
    pickLinkSummaryUpdatedAt(fullBody),
    "2026-11-23T10:00:00.000Z"
  );
  assert.equal(
    pickLinkSummaryUpdatedAt({
      updatedAt: { notes: null, progress: "2026-11-23T09:00:00.000Z" },
    }),
    "2026-11-23T09:00:00.000Z"
  );
  assert.equal(pickLinkSummaryUpdatedAt({ updatedAt: { notes: null, progress: null } }), null);
  assert.equal(pickLinkSummaryUpdatedAt({}), null);
  assert.equal(pickLinkSummaryUpdatedAt(null), null);
});

test("relative time renders Japanese recency labels", () => {
  const now = Date.parse("2026-11-23T10:30:00.000Z");
  assert.equal(formatRelativeTime("2026-11-23T10:29:40.000Z", now), "たった今");
  assert.equal(formatRelativeTime("2026-11-23T10:12:00.000Z", now), "18分前");
  assert.equal(formatRelativeTime("2026-11-23T07:30:00.000Z", now), "3時間前");
  assert.equal(formatRelativeTime("2026-11-21T10:30:00.000Z", now), "2日前");
  assert.equal(formatRelativeTime("not-a-date", now), null);
  assert.equal(formatRelativeTime(null, now), null);
});

function fakeFetch(response) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetchFn, calls };
}

test("a 200 summary maps to ok with rows, sent as Bearer to the summary URL", async () => {
  const { fetchFn, calls } = fakeFetch({
    status: 200,
    json: async () => fullBody,
  });
  const result = await fetchLinkSummary(fetchFn, "member-uuid.signature");
  assert.equal(result.kind, "ok");
  assert.equal(result.rows.length, 2);
  assert.equal(result.updatedAt, "2026-11-23T10:00:00.000Z");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, LINK_SUMMARY_URL);
  assert.equal(
    calls[0].init.headers.Authorization,
    "Bearer member-uuid.signature"
  );
});

test("a 401 is classified as unauthorized, apart from other failures", async () => {
  const { fetchFn } = fakeFetch({
    status: 401,
    json: async () => ({ ok: false, error: "link_token_invalid" }),
  });
  assert.deepEqual(await fetchLinkSummary(fetchFn, "t"), {
    kind: "unauthorized",
  });
});

test("server errors, network failures and bad bodies are plain failures", async () => {
  const server = fakeFetch({ status: 503, json: async () => ({}) });
  assert.deepEqual(await fetchLinkSummary(server.fetchFn, "t"), {
    kind: "failed",
  });
  const network = fakeFetch(new Error("offline"));
  assert.deepEqual(await fetchLinkSummary(network.fetchFn, "t"), {
    kind: "failed",
  });
  const badBody = fakeFetch({
    status: 200,
    json: async () => ({ ok: false }),
  });
  assert.deepEqual(await fetchLinkSummary(badBody.fetchFn, "t"), {
    kind: "failed",
  });
  const badJson = fakeFetch({
    status: 200,
    json: async () => {
      throw new Error("not json");
    },
  });
  assert.deepEqual(await fetchLinkSummary(badJson.fetchFn, "t"), {
    kind: "failed",
  });
});
