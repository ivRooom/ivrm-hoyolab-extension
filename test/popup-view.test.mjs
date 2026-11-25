import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_POPUP_VIEW,
  HISTORY_LIMIT,
  POPUP_VIEWS,
  STATUS_VISIBILITY_GAMES,
  STATUS_VISIBILITY_KEY,
  THEME_STORAGE_KEY,
  buildHistoryEntries,
  buildStatusRows,
  collapsibleView,
  historyToggleLabel,
  isLowPercent,
  isStatusRowVisible,
  nextCollapsibleOpen,
  nextTheme,
  normalizePopupView,
  normalizeStatusVisibility,
  popupViewState,
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

test("status visibility: key, game list, and all-on defaults (#25)", () => {
  assert.equal(STATUS_VISIBILITY_KEY, "statusVisibility");
  assert.deepEqual(STATUS_VISIBILITY_GAMES, [
    "genshin",
    "starrail",
    "endfield",
  ]);
  const allOn = { genshin: true, starrail: true, endfield: true };
  assert.deepEqual(normalizeStatusVisibility(null), allOn);
  assert.deepEqual(normalizeStatusVisibility(undefined), allOn);
  assert.deepEqual(normalizeStatusVisibility("nope"), allOn);
  // Partial values fill from the defaults; non-booleans are ignored.
  assert.deepEqual(normalizeStatusVisibility({ starrail: false }), {
    genshin: true,
    starrail: false,
    endfield: true,
  });
  assert.deepEqual(
    normalizeStatusVisibility({ genshin: "off", endfield: 0 }),
    allOn
  );
});

test("status visibility: an off game loses its row, the others stay", () => {
  const rows = buildStatusRows({
    summaryRows,
    sanity,
    gameSettings: allVisible,
    statusVisibility: { starrail: false },
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["genshin", "endfield"]
  );
  const noEndfield = buildStatusRows({
    summaryRows,
    sanity,
    gameSettings: allVisible,
    statusVisibility: normalizeStatusVisibility({ endfield: false }),
  });
  assert.deepEqual(
    noEndfield.map((row) => row.id),
    ["genshin", "starrail"]
  );
  const none = buildStatusRows({
    summaryRows,
    sanity,
    gameSettings: allVisible,
    statusVisibility: { genshin: false, starrail: false, endfield: false },
  });
  assert.deepEqual(none, []);
});

test("status visibility: the #6 display switch still wins", () => {
  const settings = normalizeGameSettings(null);
  settings.display.genshin = false;
  const rows = buildStatusRows({
    summaryRows,
    sanity,
    gameSettings: settings,
    statusVisibility: { genshin: true, starrail: true, endfield: true },
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["starrail", "endfield"]
  );
});

test("status visibility: storage round-trip keeps the choices", () => {
  // The popup stores the normalized map; reading it back (through
  // JSON, the way chrome.storage keeps it) must normalize to the
  // same map and drive the same rows.
  const chosen = normalizeStatusVisibility({
    genshin: false,
    endfield: false,
  });
  const revived = normalizeStatusVisibility(
    JSON.parse(JSON.stringify(chosen))
  );
  assert.deepEqual(revived, chosen);
  assert.equal(isStatusRowVisible(revived, "genshin"), false);
  assert.equal(isStatusRowVisible(revived, "starrail"), true);
  assert.equal(isStatusRowVisible(revived, "endfield"), false);
  const rows = buildStatusRows({
    summaryRows,
    sanity,
    gameSettings: allVisible,
    statusVisibility: revived,
  });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["starrail"]
  );
});

test("views: main is the default, settings hides main (settings layout)", () => {
  assert.deepEqual(POPUP_VIEWS, ["main", "settings"]);
  assert.equal(DEFAULT_POPUP_VIEW, "main");
  assert.equal(normalizePopupView("main"), "main");
  assert.equal(normalizePopupView("settings"), "settings");
  // Unknown names fall back to main — a corrupt caller can never
  // strand the member on a blank popup.
  assert.equal(normalizePopupView("bogus"), "main");
  assert.equal(normalizePopupView(null), "main");
  assert.equal(normalizePopupView(undefined), "main");
  assert.deepEqual(popupViewState("main"), {
    view: "main",
    mainHidden: false,
    settingsHidden: true,
    settingsAriaExpanded: "false",
  });
  assert.deepEqual(popupViewState("settings"), {
    view: "settings",
    mainHidden: true,
    settingsHidden: false,
    settingsAriaExpanded: "true",
  });
});

test("views: switching there and back restores the main view", () => {
  // The round trip the buttons drive: open on main, 設定 shows
  // the settings view, 戻る brings main back untouched.
  let state = popupViewState("main");
  assert.equal(state.mainHidden, false);
  state = popupViewState("settings");
  assert.equal(state.settingsHidden, false);
  assert.equal(state.mainHidden, true);
  state = popupViewState("main");
  assert.deepEqual(state, popupViewState(DEFAULT_POPUP_VIEW));
});

test("views: settings controls live in the settings view, not main", async () => {
  const html = await readFile(
    new URL("../src/popup.html", import.meta.url),
    "utf8"
  );
  const header = html.slice(0, html.indexOf('id="main-view"'));
  const main = html.slice(
    html.indexOf('id="main-view"'),
    html.indexOf('id="settings-view"')
  );
  const settings = html.slice(
    html.indexOf('id="settings-view"'),
    html.indexOf("<footer")
  );
  // The 設定 button sits in the shared header.
  assert.ok(header.includes('id="settings-button"'));
  // Everything set-once moved: the theme control, the status
  // visibility switches (#25), the automation master switch and
  // the per-game switches (#6).
  for (const id of [
    "theme-toggle",
    "status-visibility",
    "auto-enabled",
    "game-settings",
    "settings-back",
  ]) {
    assert.ok(settings.includes(`id="${id}"`), `${id} in settings view`);
    assert.ok(!main.includes(`id="${id}"`), `${id} not in main view`);
  }
  // Status and actions stayed: the status rows, the pairing
  // section, the run-now button, and the receipt history (#26).
  for (const id of [
    "link-summary-body",
    "auto-link-button",
    "code-toggle",
    "auto-run-now",
    "history-button",
    "auto-status",
    "game-status",
  ]) {
    assert.ok(main.includes(`id="${id}"`), `${id} in main view`);
    assert.ok(!settings.includes(`id="${id}"`), `${id} not in settings`);
  }
});

test("collapsible: taps alternate expand → collapse → expand (#26)", () => {
  let open = false;
  const sequence = [open];
  for (let i = 0; i < 3; i += 1) {
    open = nextCollapsibleOpen(open);
    sequence.push(open);
  }
  assert.deepEqual(sequence, [false, true, false, true]);
  // Every derived piece of the toggle follows the same flag, so
  // the box, the chevron, and aria-expanded cannot drift apart.
  assert.deepEqual(collapsibleView(false), {
    boxHidden: true,
    openClass: false,
    ariaExpanded: "false",
  });
  assert.deepEqual(collapsibleView(true), {
    boxHidden: false,
    openClass: true,
    ariaExpanded: "true",
  });
  assert.equal(historyToggleLabel(false), "受け取り履歴を表示");
  assert.equal(historyToggleLabel(true), "受け取り履歴を閉じる");
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
