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
// Popup views (settings layout)
//
// The popup has two views: "main" (status rows, the link actions,
// the run state, the receipt history) and "settings" (everything
// the member sets once and rarely touches: the theme, the status
// row visibility switches, and the automation switches). The
// header's 設定 button switches to the settings view and its
// 戻る button switches back. The view is deliberately not
// persisted — every popup open starts on main — so this model
// only derives, from the current view name, which container is
// hidden and what the settings button reports to assistive tech.
// Unknown names fall back to main, the safe default.

export const POPUP_VIEWS = ["main", "settings"];
export const DEFAULT_POPUP_VIEW = "main";

export function normalizePopupView(name) {
  return POPUP_VIEWS.includes(name) ? name : DEFAULT_POPUP_VIEW;
}

export function popupViewState(name) {
  const view = normalizePopupView(name);
  const onSettings = view === "settings";
  return {
    view,
    mainHidden: onSettings,
    settingsHidden: !onSettings,
    settingsAriaExpanded: onSettings ? "true" : "false",
  };
}

// ----------------------------------------------------------------
// Status row visibility (#25)
//
// A display-only preference for the status section: one switch
// per status-capable game, stored under STATUS_VISIBILITY_KEY.
// It is deliberately separate from the per-game settings (#6):
// that "display" switch also gates the automation (the effective
// state is display && automation), while this one only decides
// whether the game's row is drawn here. It never affects
// fetching, check-in, redemption, or the receipt history.
//
// A row is drawn only when both switches allow it — a game hidden
// in the #6 settings stays hidden here too. The default is all
// on, so existing users see no change.

export const STATUS_VISIBILITY_KEY = "statusVisibility";
export const STATUS_VISIBILITY_GAMES = [
  "genshin",
  "starrail",
  "zzz",
  "endfield",
];

export function defaultStatusVisibility() {
  const visibility = {};
  for (const id of STATUS_VISIBILITY_GAMES) visibility[id] = true;
  return visibility;
}

export function normalizeStatusVisibility(raw) {
  const visibility = defaultStatusVisibility();
  if (raw && typeof raw === "object") {
    for (const id of STATUS_VISIBILITY_GAMES) {
      if (typeof raw[id] === "boolean") visibility[id] = raw[id];
    }
  }
  return visibility;
}

export function isStatusRowVisible(visibility, gameId) {
  return normalizeStatusVisibility(visibility)[gameId] !== false;
}

// ----------------------------------------------------------------
// Status rows
//
// Rows come only from data that actually exists — the same rule
// the summary section has always followed. The portal summary
// covers Genshin / Star Rail and, since ivrm-web #1812, ZZZ's
// battery charge; the Endfield row is built from the sanity
// reading the Skport worker caches. A game with no data (not
// registered, fetch failed) gets no row — nothing is fabricated
// for the mock's sake.
//
// A game the member hid — in the per-game settings (display off)
// or in the status visibility switches above (#25) — gets no row.
// A row is "low" below half charge: the dot turns amber and the
// bar dims, per the mock.

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

export function buildStatusRows({
  summaryRows,
  sanity,
  gameSettings,
  statusVisibility,
} = {}) {
  const display = gameSettings?.display ?? {};
  const visibility = normalizeStatusVisibility(statusVisibility);
  const visible = (id) => display[id] !== false && visibility[id] !== false;
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

// ----------------------------------------------------------------
// Collapsible sections (#26)
//
// The pairing-code box and the receipt history open and close
// through one shared state machine. The open flag is owned by
// the wiring in popup.js and every visible state of the toggle —
// the box, the chevron class, aria-expanded, and (for the
// history) the button label — is derived from it here, never
// read back from the DOM, so a tap can only ever flip the
// section and the states cannot drift apart. The flip-flop is
// pinned by the test suite (expand → collapse → expand).

export function nextCollapsibleOpen(open) {
  return open !== true;
}

export function collapsibleView(open) {
  const isOpen = open === true;
  return {
    boxHidden: !isOpen,
    openClass: isOpen,
    ariaExpanded: isOpen ? "true" : "false",
  };
}

export const HISTORY_LABEL_OPEN = "受け取り履歴を閉じる";
export const HISTORY_LABEL_CLOSED = "受け取り履歴を表示";

export function historyToggleLabel(open) {
  return open === true ? HISTORY_LABEL_OPEN : HISTORY_LABEL_CLOSED;
}
