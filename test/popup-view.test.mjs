import assert from "node:assert/strict";
import test from "node:test";
import {
  HISTORY_LIMIT,
  THEME_STORAGE_KEY,
  buildHistoryEntries,
  buildStatusRows,
  isLowPercent,
  nextTheme,
  resolveTheme,
} from "../src/lib/popup-view.mjs";
import {
  LINK_SUMMARY_CACHE_KEY,
  LINK_SUMMARY_REFRESH_MINUTES,
  buildLinkSummaryCache,
  formatSyncTime,
  parseLinkSummaryCache,
} from "../src/lib/hoyolab-link.mjs";
import { normalizeGameSettings } from "../src/lib/game-settings.mjs";

// #15: popup v2. The properties that matter: a stored theme
// choice always wins over the OS preference; status rows exist
// only for games with real data (plus the cached Endfield sanity)
// and respect the display switches; the receipt history is the
// check-in / redemption slice of the run log, newest first; and
// the summary cache only ever stores successful fetches, so its
// timestamp is an honest "last synced".

test("theme: stored choice wins, OS preference is the fallback", () => {
  assert.equal(resolveTheme("light", false), "light");
  assert.equal(resolveTheme("dark", true), "dark");
  assert.equal(resolveTheme(null, true), "light");
  assert.equal(resolveTheme(null, false), "dark");
  assert.equal(resolveTheme("sepia", true), "light");
  assert.equal(resolveTheme(undefined, false), "dark");
  assert.equal(nextTheme("dark"), "light");
  assert.equal(nextTheme("light"), "dark");
  assert.equal(THEME_STORAGE_KEY, "popupTheme");
});

const summaryRows = [
  {
    id: "genshin",
    label: "原神",
    icon: "icon-genshin.png",
    metricLabel: "樹脂",
    current: 142,
    max: 200,
    percent: 71,
    explorationPercent: 55.5,
  },
  {
    id: "starrail",
    label: "崩壊：スターレイル",
    icon: "icon-starrail.png",
    metricLabel: "開拓力",
    current: 96,
    max: 240,
    percent: 40,
    explorationPercent: null,
  },
];
const sanity = { current: 156, max: 240, at: 1_764_000_000_000 };
const allVisible = normalizeGameSettings(null);

test("status rows: summary games plus the Endfield sanity row", () => {
  const rows = buildStatusRows({
    summaryRows,
    sanity,
    gameSettings: allVisible,
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["genshin", "starrail", "endfield"]
  );
  assert.equal(rows[0].label, "原神");
  assert.equal(rows[0].low, false);
  assert.equal(rows[0].explorationPercent, 55.5);
  // The mock's short name wins over the registry's long one.
  assert.equal(rows[1].label, "スターレイル");
  assert.equal(rows[1].low, true);
  assert.deepEqual(rows[2], {
    id: "endfield",
    label: "エンドフィールド",
    icon: "icon-endfield.png",
    metricLabel: "理性",
    current: 156,
    max: 240,
    percent: 65,
    low: false,
    explorationPercent: null,
  });
});

test("status rows: hidden games and missing data produce no row", () => {
  const settings = normalizeGameSettings(null);
  settings.display.starrail = false;
  settings.display.endfield = false;
  const rows = buildStatusRows({
    summaryRows,
    sanity,
    gameSettings: settings,
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["genshin"]
  );
  // No sanity cached yet: no Endfield row is invented.
  assert.deepEqual(
    buildStatusRows({
      summaryRows: [],
      sanity: null,
      gameSettings: allVisible,
    }),
    []
  );
  assert.deepEqual(buildStatusRows(), []);
  assert.equal(isLowPercent(49), true);
  assert.equal(isLowPercent(50), false);
  assert.equal(isLowPercent(null), false);
});

const log = [
  { at: 100, kind: "system", outcome: "success", detail: "自動連携" },
  { at: 200, kind: "checkin", game: "genshin", outcome: "success" },
  {
    at: 300,
    kind: "redeem",
    game: "zzz",
    code: "ZZZ25ABCD",
    outcome: "already_used",
    detail: "",
  },
  { at: 400, kind: "auth", outcome: "not_logged_in" },
  {
    at: 500,
    kind: "checkin",
    game: "endfield",
    outcome: "success",
    detail: "原石×60",
  },
  { at: 600, kind: "redeem", game: "genshin", outcome: "success" },
];

test("history: check-in and redemption only, newest first", () => {
  const entries = buildHistoryEntries(log);
  assert.deepEqual(
    entries.map((entry) => entry.at),
    [600, 500, 300, 200]
  );
  assert.deepEqual(entries[1], {
    at: 500,
    kind: "checkin",
    game: "endfield",
    code: null,
    outcome: "success",
    detail: "原石×60",
  });
  assert.equal(entries[2].code, "ZZZ25ABCD");
  assert.equal(entries[2].detail, null);
  assert.deepEqual(buildHistoryEntries(null), []);
  assert.deepEqual(buildHistoryEntries("nope"), []);
});

test("history: the display cap keeps the newest entries", () => {
  const big = Array.from({ length: HISTORY_LIMIT + 5 }, (_, i) => ({
    at: i + 1,
    kind: "checkin",
    game: "genshin",
    outcome: "success",
  }));
  const entries = buildHistoryEntries(big);
  assert.equal(entries.length, HISTORY_LIMIT);
  assert.equal(entries[0].at, HISTORY_LIMIT + 5);
  assert.equal(buildHistoryEntries(big, 2).length, 2);
});

test("summary cache: only successful fetches are cached", () => {
  const ok = { kind: "ok", rows: summaryRows, updatedAt: "2026-11-24T05:00:00.000Z" };
  assert.deepEqual(buildLinkSummaryCache(ok, 1234), {
    at: 1234,
    rows: summaryRows,
    updatedAt: "2026-11-24T05:00:00.000Z",
  });
  assert.equal(buildLinkSummaryCache({ kind: "failed" }, 1234), null);
  assert.equal(buildLinkSummaryCache({ kind: "unauthorized" }, 1234), null);
  assert.equal(buildLinkSummaryCache(null, 1234), null);
  assert.equal(LINK_SUMMARY_REFRESH_MINUTES, 30);
  assert.equal(LINK_SUMMARY_CACHE_KEY, "linkSummaryCache");
});

test("summary cache: parsing is defensive", () => {
  const cache = buildLinkSummaryCache(
    { kind: "ok", rows: summaryRows, updatedAt: null },
    1234
  );
  assert.deepEqual(parseLinkSummaryCache(cache), cache);
  assert.equal(parseLinkSummaryCache(null), null);
  assert.equal(parseLinkSummaryCache({ at: "1234", rows: [] }), null);
  assert.equal(parseLinkSummaryCache({ at: 1234, rows: "x" }), null);
  const mixed = parseLinkSummaryCache({
    at: 5,
    rows: [summaryRows[0], { id: 7 }, null],
    updatedAt: 9,
  });
  assert.equal(mixed.rows.length, 1);
  assert.equal(mixed.updatedAt, null);
});

test("sync time: JST HH:MM, null for unusable stamps", () => {
  // 2026-11-24T05:05:00Z is 14:05 JST.
  assert.equal(formatSyncTime(Date.parse("2026-11-24T05:05:00.000Z")), "14:05");
  assert.equal(formatSyncTime(0), null);
  assert.equal(formatSyncTime(null), null);
  assert.equal(formatSyncTime("14:05"), null);
});
