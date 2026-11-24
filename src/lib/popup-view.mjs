// View models for the v2 popup (ivrm-hoyolab-extension #15).
//
// The popup's rendering decisions live here, free of chrome.* and
// DOM APIs, so node --test can pin them: which theme applies,
// which status rows exist (and whether a row reads as "low"), and
// how the stored execution log becomes the receipt history.
//
// Design source: the Kanata-approved v2 mock
// (workspace scratch popup-redesign-mock/v2) — minimal layout,
// light/dark themes, official game icons, per-game tinted
// hairline bars, semantic status dots.

// ----------------------------------------------------------------
// Theme
//
// The member's explicit choice is stored under THEME_STORAGE_KEY
// and always wins. Before any choice exists, the OS preference
// (prefers-color-scheme) decides; the historical default of this
// extension is dark.

export const THEME_STORAGE_KEY = "popupTheme";
export const THEMES = ["dark", "light"];

export function resolveTheme(stored, prefersLight) {
  if (stored === "light" || stored === "dark") return stored;
  return prefersLight ? "light" : "dark";
}

export function nextTheme(current) {
  return current === "light" ? "dark" : "light";
}

// ----------------------------------------------------------------
// Status rows
//
// Rows come only from data that actually exists — the same rule
// the summary section has always followed. The portal summary
// covers Genshin / Star Rail; the Endfield row is built from the
// sanity reading the Skport worker caches. ZZZ's battery charge
// has no data source today (the portal summary does not carry it
// and HoYoLAB's note for ZZZ is not fetched), so no ZZZ row is
// fabricated for the mock's sake.
//
// A game the member hid in the per-game settings (display off)
// gets no row. A row is "low" below half charge: the dot turns
// amber and the bar dims, per the mock.

export const STATUS_ROW_LABELS = {
  genshin: "原神",
  starrail: "スターレイル",
  zzz: "ゼンレスゾーンゼロ",
  endfield: "エンドフィールド",
};

export const LOW_PERCENT = 50;

export function isLowPercent(percent) {
  return typeof percent === "number" && percent < LOW_PERCENT;
}

export function buildStatusRows({ summaryRows, sanity, gameSettings } = {}) {
  const display = gameSettings?.display ?? {};
  const visible = (id) => display[id] !== false;
  const rows = [];
  for (const row of Array.isArray(summaryRows) ? summaryRows : []) {
    if (!visible(row.id)) continue;
    rows.push({
      id: row.id,
      label: STATUS_ROW_LABELS[row.id] ?? row.label,
      icon: row.icon,
      metricLabel: row.metricLabel,
      current: row.current,
      max: row.max,
      percent: row.percent ?? null,
      low: isLowPercent(row.percent),
      explorationPercent:
        typeof row.explorationPercent === "number"
          ? row.explorationPercent
          : null,
    });
  }
  if (
    visible("endfield") &&
    sanity &&
    typeof sanity.current === "number" &&
    typeof sanity.max === "number" &&
    sanity.max > 0
  ) {
    const percent = Math.min(
      100,
      Math.max(0, Math.round((sanity.current / sanity.max) * 100))
    );
    rows.push({
      id: "endfield",
      label: STATUS_ROW_LABELS.endfield,
      icon: "icon-endfield.png",
      metricLabel: "理性",
      current: sanity.current,
      max: sanity.max,
      percent,
      low: isLowPercent(percent),
      explorationPercent: null,
    });
  }
  return rows;
}

// ----------------------------------------------------------------
// Receipt history (#15)
//
// 「受け取り履歴」: the check-in and code-redemption entries of
// the shared execution log, newest first, capped for display.
// Each entry keeps what the log actually recorded — time, game,
// result, the code for redemptions, and the detail text (which
// carries the reward names for Endfield check-ins). Entries of
// other kinds (auth / system notices) are not receipts and are
// left to the run log below the history.

export const HISTORY_LIMIT = 30;
export const HISTORY_KINDS = ["checkin", "redeem"];

export function buildHistoryEntries(log, limit = HISTORY_LIMIT) {
  if (!Array.isArray(log)) return [];
  const cap =
    typeof limit === "number" && limit > 0 ? limit : HISTORY_LIMIT;
  return log
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        HISTORY_KINDS.includes(entry.kind) &&
        typeof entry.at === "number"
    )
    .slice(-cap)
    .reverse()
    .map((entry) => ({
      at: entry.at,
      kind: entry.kind,
      game: typeof entry.game === "string" ? entry.game : null,
      code: typeof entry.code === "string" ? entry.code : null,
      outcome: typeof entry.outcome === "string" ? entry.outcome : "",
      detail:
        typeof entry.detail === "string" && entry.detail !== ""
          ? entry.detail
          : null,
    }));
}
