import {
  buildHoyolabCookieString,
  describeExchangeResult,
  extractLinkToken,
  isPairingTokenShape,
  PAIRING_EXCHANGE_URL,
} from "./lib/hoyolab-cookie.mjs";
import {
  AUTO_LINK_PAGE_URL,
  LINKED_DISPLAY_NAME_STORAGE_KEY,
  extractDisplayName,
} from "./lib/auto-link.mjs";
import {
  LINK_SUMMARY_CACHE_KEY,
  LINK_TOKEN_STORAGE_KEY,
  buildLinkSummaryCache,
  fetchLinkSummary,
  formatSyncTime,
  parseLinkSummaryCache,
} from "./lib/hoyolab-link.mjs";
import {
  STATUS_ROW_LABELS,
  STATUS_VISIBILITY_GAMES,
  STATUS_VISIBILITY_KEY,
  THEME_STORAGE_KEY,
  buildHistoryEntries,
  buildStatusRows,
  collapsibleView,
  historyToggleLabel,
  nextCollapsibleOpen,
  nextTheme,
  normalizeStatusVisibility,
  popupViewState,
  resolveTheme,
} from "./lib/popup-view.mjs";
import {
  AUTO_STORAGE_KEYS,
  countSuccessfulRedeems,
  describeAutoOutcome,
  describeAutoOutcomeHint,
  jstMonthKey,
  normalizeAutoSettings,
} from "./lib/hoyolab-auto.mjs";
import {
  GAME_IDS,
  GAME_INFO,
  GAME_SETTINGS_KEY,
  isGameAutomationEffective,
  migrateGameSettings,
  normalizeGameSettings,
} from "./lib/game-settings.mjs";
import {
  AUTH_STATE_KEY,
  anyAuthExpired,
  isAuthExpired,
  normalizeAuthState,
} from "./lib/session-resilience.mjs";

const SKPORT_STATE_KEY = "skportState";

const sessionStatus = document.getElementById("session-status");
const sessionDot = document.getElementById("session-dot");
const tokenInput = document.getElementById("pairing-token");
const linkButton = document.getElementById("link-button");
const autoLinkButton = document.getElementById("auto-link-button");
const result = document.getElementById("result");
const linkState = document.getElementById("link-state");

// ---------------------------------------------------------------
// Views: the popup opens on the main view (status, actions, run
// state, history). The header's 設定 button switches to the
// settings view, which gathers everything the member sets once —
// the theme, the status row visibility (#25), and the automation
// switches (#6) — and its 戻る button switches back. The view is
// not persisted: every open starts on main. The derivation lives
// in the popup-view model; this wiring only applies it.

const mainView = document.getElementById("main-view");
const settingsView = document.getElementById("settings-view");
const settingsButton = document.getElementById("settings-button");
const settingsBack = document.getElementById("settings-back");
let currentView = "main";

function renderView() {
  const state = popupViewState(currentView);
  mainView.hidden = state.mainHidden;
  settingsView.hidden = state.settingsHidden;
  settingsButton.setAttribute("aria-expanded", state.settingsAriaExpanded);
  currentView = state.view;
}

settingsButton.addEventListener("click", () => {
  currentView = "settings";
  renderView();
});

settingsBack.addEventListener("click", () => {
  currentView = "main";
  renderView();
});

renderView();

// ---------------------------------------------------------------
// Theme (#15): the stored choice wins; before any choice, the OS
// preference decides. The toggle lives in the settings view and
// flips and stores.

const themeToggle = document.getElementById("theme-toggle");
const themeState = document.getElementById("theme-state");
const SUN_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

function renderThemeIcon(theme) {
  themeToggle.innerHTML = theme === "dark" ? SUN_ICON : MOON_ICON;
  themeState.textContent = theme === "dark" ? "ダーク" : "ライト";
}

async function initTheme() {
  let stored = null;
  try {
    const values = await chrome.storage.local.get([THEME_STORAGE_KEY]);
    stored = values[THEME_STORAGE_KEY];
  } catch {
    stored = null;
  }
  const prefersLight =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const theme = resolveTheme(stored, prefersLight);
  document.documentElement.dataset.theme = theme;
  renderThemeIcon(theme);
}

themeToggle.addEventListener("click", async () => {
  const theme = nextTheme(document.documentElement.dataset.theme);
  document.documentElement.dataset.theme = theme;
  renderThemeIcon(theme);
  try {
    await chrome.storage.local.set({ [THEME_STORAGE_KEY]: theme });
  } catch {
    // The choice applies to this open even if storing failed.
  }
});

void initTheme();

document.getElementById("footer-version").textContent =
  `v${chrome.runtime.getManifest().version}`;

function setStatus(element, text, kind) {
  element.textContent = text;
  element.classList.remove("ok", "ng");
  if (kind) element.classList.add(kind);
}

async function readSessionCookieString() {
  const cookies = await chrome.cookies.getAll({ domain: "hoyolab.com" });
  return buildHoyolabCookieString(cookies);
}

// On open, report whether a usable HoYoLAB session exists in this
// browser profile. The cookie values themselves are never shown.
async function refreshSessionStatus() {
  try {
    const cookie = await readSessionCookieString();
    if (cookie) {
      sessionDot.className = "dot";
      setStatus(sessionStatus, "HoYoLAB ログイン中", "ok");
    } else {
      sessionDot.className = "dot ng";
      setStatus(
        sessionStatus,
        "ログインが検出できません。HoYoLAB にログインしてから開き直してください。",
        "ng"
      );
    }
  } catch {
    sessionDot.className = "dot ng";
    setStatus(sessionStatus, "ログイン状態を確認できませんでした。", "ng");
  }
}

// Auto-link (#14): opens the portal's link page in a new tab.
// The member confirms there, the page hands the minted token to
// the extension's content script, and the background runs the
// exchange — this popup only has to open the page. The result is
// visible here on the next open (link state + execution log).
autoLinkButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: AUTO_LINK_PAGE_URL });
});

// Collapsible sections (#26): one shared wiring for the quiet
// rows that open a box (the pairing-code entry, the receipt
// history). The open flag lives here — never read back from the
// DOM — and every visible state of the toggle (the box, the
// chevron class, aria-expanded) is derived from it through the
// popup-view model, so repeated taps always alternate and the
// button can never drift out of sync with the box.
function wireCollapsible(button, box, onView) {
  let open = !box.hidden;
  const render = () => {
    const view = collapsibleView(open);
    box.hidden = view.boxHidden;
    button.classList.toggle("open", view.openClass);
    button.setAttribute("aria-expanded", view.ariaExpanded);
    if (onView) onView(open);
  };
  button.addEventListener("click", () => {
    open = nextCollapsibleOpen(open);
    render();
  });
  render();
}

// The pairing-code entry is the fallback (#14): collapsed behind
// a quiet row until the member opens it.
const codeToggle = document.getElementById("code-toggle");
const codeBox = document.getElementById("code-box");
wireCollapsible(codeToggle, codeBox);

linkButton.addEventListener("click", async () => {
  const pairingToken = tokenInput.value.trim();
  if (!isPairingTokenShape(pairingToken)) {
    setStatus(
      result,
      "ペアリングコードの形が違います。ポータルで発行したコードをそのまま貼ってください。",
      "ng"
    );
    return;
  }
  linkButton.disabled = true;
  setStatus(result, "連携しています…", null);
  try {
    const cookie = await readSessionCookieString();
    if (!cookie) {
      setStatus(
        result,
        "HoYoLAB のログインが検出できません。ログインしてからお試しください。",
        "ng"
      );
      return;
    }
    const response = await fetch(PAIRING_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingToken, cookie }),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const described = describeExchangeResult(response.status, body);
    setStatus(result, described.message, described.ok ? "ok" : "ng");
    if (described.ok) {
      tokenInput.value = "";
      // Remember that this browser has linked before, so the next
      // open can say so; the form stays usable for re-linking.
      // When the exchange issued a read-only link token (#1675),
      // store it for the status section; when it did not (the
      // portal feature is off), drop any older token so the
      // section never presents a credential the portal no longer
      // honors.
      const linkedAt = Date.now();
      const linkToken = extractLinkToken(response.status, body);
      const displayName = extractDisplayName(response.status, body);
      try {
        await chrome.storage.local.set({ portalLinkedAt: linkedAt });
        if (linkToken) {
          await chrome.storage.local.set({
            [LINK_TOKEN_STORAGE_KEY]: linkToken,
          });
        } else {
          await chrome.storage.local.remove(LINK_TOKEN_STORAGE_KEY);
        }
        if (displayName) {
          await chrome.storage.local.set({
            [LINKED_DISPLAY_NAME_STORAGE_KEY]: displayName,
          });
        } else {
          await chrome.storage.local.remove(LINKED_DISPLAY_NAME_STORAGE_KEY);
        }
      } catch {
        // Non-fatal: the link itself already succeeded.
      }
      renderLinkState(linkedAt, displayName);
      refreshLinkSummary();
    }
  } catch {
    setStatus(
      result,
      "通信できませんでした。ネットワークを確認してもう一度お試しください。",
      "ng"
    );
  } finally {
    linkButton.disabled = false;
  }
});

// Shows when this browser last linked successfully (the timestamp
// is stored by the pairing handler above). Uses the shared JST
// formatter declared with the automation section below; it only
// runs after the popup has fully loaded.
function renderLinkState(linkedAt, displayName) {
  if (typeof linkedAt === "number" && linkedAt > 0) {
    const who =
      typeof displayName === "string" && displayName !== ""
        ? `${displayName} さん・`
        : "";
    setStatus(
      linkState,
      `ポータル連携済み（${who}${timeFormat.format(new Date(linkedAt))}）`,
      "ok"
    );
  } else {
    linkState.textContent = "";
    linkState.classList.remove("ok", "ng");
  }
}

async function refreshLinkState() {
  try {
    const stored = await chrome.storage.local.get([
      "portalLinkedAt",
      LINKED_DISPLAY_NAME_STORAGE_KEY,
    ]);
    renderLinkState(
      stored.portalLinkedAt,
      stored[LINKED_DISPLAY_NAME_STORAGE_KEY]
    );
  } catch {
    renderLinkState(null, null);
  }
}

refreshSessionStatus();
refreshLinkState();

// ---------------------------------------------------------------
// Current status (link summary). When the pairing exchange issued
// a read-only link token, the popup reads the member's resin /
// trailblaze power / exploration from the portal and shows it
// above the automation section. Without a token the section only
// appears — as a one-line hint — for browsers that linked before
// the feature existed; never-linked browsers see nothing extra.

const summarySection = document.getElementById("link-summary");
const summaryBody = document.getElementById("link-summary-body");
const summaryRefresh = document.getElementById("link-summary-refresh");
const summarySync = document.getElementById("summary-sync");
const statusVisibilityBox = document.getElementById("status-visibility");

function summaryHint(text) {
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = text;
  return hint;
}

// One status row in the v2 layout: icon, semantic dot, name, and
// the metric with a per-game tinted hairline bar.
function renderStatusRow(row) {
  const item = document.createElement("div");
  item.className = "game";

  const head = document.createElement("div");
  head.className = "game-head";
  const name = document.createElement("div");
  name.className = "game-name";
  const icon = document.createElement("img");
  icon.className = "game-icon";
  icon.src = row.icon;
  icon.alt = "";
  icon.addEventListener("error", () => {
    const dot = document.createElement("span");
    dot.className = "game-dot";
    dot.textContent = row.label.slice(0, 1);
    icon.replaceWith(dot);
  });
  const dot = document.createElement("span");
  dot.className = row.low ? "dot low" : "dot";
  const label = document.createElement("span");
  label.textContent = row.label;
  name.append(icon, dot, label);

  const value = document.createElement("div");
  value.className = "game-value";
  value.append(document.createTextNode(`${row.metricLabel} `));
  const current = document.createElement("b");
  current.textContent = String(row.current);
  value.append(current, document.createTextNode(` / ${row.max}`));
  head.append(name, value);
  item.append(head);

  if (row.percent !== null) {
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("i");
    fill.className = `t-${row.id}${row.low ? " low" : ""}`;
    fill.style.width = `${row.percent}%`;
    bar.append(fill);
    item.append(bar);
  }
  if (row.explorationPercent !== null) {
    const sub = document.createElement("div");
    sub.className = "summary-sub";
    sub.textContent = `探索度 ${row.explorationPercent.toFixed(1)}%`;
    item.append(sub);
  }
  return item;
}

function renderStatusRows(rows) {
  if (rows.length === 0) {
    summaryBody.replaceChildren(
      summaryHint("まだ表示できるデータがありません。ポータルにデータが届くと、ここにも表示されます。")
    );
    return;
  }
  summaryBody.replaceChildren(...rows.map(renderStatusRow));
}

function renderSyncLine(at) {
  const time = formatSyncTime(at);
  summarySync.textContent = time ? `最終同期 ${time}` : "";
}

function renderLinkSummary(result, context) {
  summaryRefresh.hidden = false;
  if (result.kind === "unauthorized") {
    summaryBody.replaceChildren(
      summaryHint(
        "連携の状態が変わったため、状況を表示できません。ポータルで連携し直してください。"
      )
    );
    return;
  }
  if (result.kind === "failed") {
    summaryBody.replaceChildren(
      summaryHint("状況を取得できませんでした。「更新」でもう一度お試しください。")
    );
    return;
  }
  renderStatusRows(
    buildStatusRows({
      summaryRows: result.rows,
      sanity: context.sanity,
      gameSettings: context.gameSettings,
      statusVisibility: context.statusVisibility,
    })
  );
}

async function refreshLinkSummary() {
  let stored = {};
  try {
    stored = await chrome.storage.local.get([
      LINK_TOKEN_STORAGE_KEY,
      LINK_SUMMARY_CACHE_KEY,
      "portalLinkedAt",
      SKPORT_STATE_KEY,
      GAME_SETTINGS_KEY,
      STATUS_VISIBILITY_KEY,
    ]);
  } catch {
    stored = {};
  }
  const token = stored[LINK_TOKEN_STORAGE_KEY];
  const context = {
    sanity: stored[SKPORT_STATE_KEY]?.sanity ?? null,
    gameSettings: normalizeGameSettings(stored[GAME_SETTINGS_KEY]),
    statusVisibility: normalizeStatusVisibility(stored[STATUS_VISIBILITY_KEY]),
  };
  if (typeof token === "string" && token !== "") {
    summarySection.hidden = false;
    summaryRefresh.hidden = false;
    // Render the cache first (the background keeps it fresh on a
    // ~30-minute alarm), then replace it with the live fetch.
    const cache = parseLinkSummaryCache(stored[LINK_SUMMARY_CACHE_KEY]);
    if (cache) {
      renderStatusRows(
        buildStatusRows({
          summaryRows: cache.rows,
          sanity: context.sanity,
          gameSettings: context.gameSettings,
          statusVisibility: context.statusVisibility,
        })
      );
      renderSyncLine(cache.at);
    } else {
      summaryBody.replaceChildren(summaryHint("読み込んでいます…"));
    }
    const result = await fetchLinkSummary(
      (url, init) => fetch(url, init),
      token
    );
    if (result.kind === "ok") {
      const fresh = buildLinkSummaryCache(result, Date.now());
      if (fresh) {
        try {
          await chrome.storage.local.set({
            [LINK_SUMMARY_CACHE_KEY]: fresh,
          });
        } catch {
          // The live values are already on screen.
        }
        renderSyncLine(fresh.at);
      }
      renderLinkSummary(result, context);
    } else if (result.kind === "unauthorized") {
      try {
        await chrome.storage.local.remove(LINK_SUMMARY_CACHE_KEY);
      } catch {
        // The hint below is what matters.
      }
      renderSyncLine(null);
      renderLinkSummary(result, context);
    } else if (!cache) {
      renderLinkSummary(result, context);
    }
    // A failed fetch with a cache on screen keeps the cached rows
    // and their 最終同期 label — that is what the label is for.
    return;
  }
  renderSyncLine(null);
  if (typeof stored.portalLinkedAt === "number" && stored.portalLinkedAt > 0) {
    // Linked before link tokens existed (or while the portal
    // feature was off): one quiet line explaining how the section
    // lights up, and no refresh button — there is nothing to read.
    summarySection.hidden = false;
    summaryRefresh.hidden = true;
    summaryBody.replaceChildren(
      summaryHint(
        "ポータルで連携し直すと、ここに現在の樹脂や開拓力が表示されます。"
      )
    );
    return;
  }
  summarySection.hidden = true;
}

summaryRefresh.addEventListener("click", refreshLinkSummary);

// Status row visibility (#25): one switch per status-capable
// game, always listed in the settings view — even for games with
// no data yet — so the member can pre-configure. The switches
// only restyle the status section: they are re-read with every
// summary render, and they never touch the fetch, the automation,
// or the history. (The per-game "表示" switch in the automation
// settings is a different, stronger setting: it also gates the
// automation.)
let statusVisibility = normalizeStatusVisibility(null);

function renderStatusVisibility(visibility) {
  const rows = STATUS_VISIBILITY_GAMES.map((id) => {
    const row = document.createElement("div");
    row.className = "game-row";

    const icon = document.createElement("img");
    icon.className = "game-icon";
    icon.src = GAME_INFO[id].icon;
    icon.alt = "";
    icon.addEventListener("error", () => {
      const dot = document.createElement("span");
      dot.className = "game-dot";
      dot.textContent = STATUS_ROW_LABELS[id].slice(0, 1);
      icon.replaceWith(dot);
    });
    row.append(icon);

    const label = document.createElement("span");
    label.className = "game-label";
    label.textContent = STATUS_ROW_LABELS[id];
    row.append(label);

    const toggleLabel = document.createElement("label");
    toggleLabel.className = "mini-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "switch-input";
    input.dataset.game = id;
    input.checked = visibility[id];
    const switchEl = document.createElement("span");
    switchEl.className = "switch";
    switchEl.setAttribute("aria-hidden", "true");
    toggleLabel.append(input, switchEl, document.createTextNode("表示"));
    row.append(toggleLabel);

    return row;
  });
  statusVisibilityBox.replaceChildren(...rows);
}

async function initStatusVisibility() {
  try {
    const stored = await chrome.storage.local.get([STATUS_VISIBILITY_KEY]);
    statusVisibility = normalizeStatusVisibility(stored[STATUS_VISIBILITY_KEY]);
  } catch {
    statusVisibility = normalizeStatusVisibility(null);
  }
  renderStatusVisibility(statusVisibility);
}

statusVisibilityBox.addEventListener("change", async (event) => {
  const input = event.target;
  const gameId = input?.dataset?.game;
  if (!gameId) return;
  statusVisibility = normalizeStatusVisibility({
    ...statusVisibility,
    [gameId]: input.checked,
  });
  try {
    await chrome.storage.local.set({
      [STATUS_VISIBILITY_KEY]: statusVisibility,
    });
  } catch {
    // The choice still applies to this open.
  }
  renderStatusVisibility(statusVisibility);
  refreshLinkSummary();
});

void initStatusVisibility();

refreshLinkSummary();

// ---------------------------------------------------------------
// Automation (check-in + gift codes) and per-game settings (#6).
// Settings live in chrome.storage.local and are read by the
// service worker on every run; this section only edits them and
// renders the state and log the workers leave behind.
//
// Two storage shapes are kept in sync here:
// - "gameSettings" (#6): per-game display / automation switches
//   for every game, the canonical model the popup edits.
// - "autoSettings" (legacy): the HoYoLAB master switch plus its
//   per-game switches, synced to the effective values
//   (display && automation) whenever the popup writes settings,
//   so the HoYoLAB worker sees the same picture either way.

const autoEnabled = document.getElementById("auto-enabled");
const autoStatus = document.getElementById("auto-status");
const autoCounts = document.getElementById("auto-counts");
const autoLog = document.getElementById("auto-log");
const autoRunNow = document.getElementById("auto-run-now");
const historyButton = document.getElementById("history-button");
const historyButtonLabel = document.getElementById("history-button-label");
const historyBox = document.getElementById("history-box");
const historyList = document.getElementById("history-list");
const gameSettingsBox = document.getElementById("game-settings");
const gameStatusBox = document.getElementById("game-status");
const authBanner = document.getElementById("auth-banner");
const authBannerHoyolab = document.getElementById("auth-banner-hoyolab");
const authBannerSkport = document.getElementById("auth-banner-skport");

const timeFormat = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

async function readAutoData() {
  const stored = await chrome.storage.local.get([
    AUTO_STORAGE_KEYS.settings,
    AUTO_STORAGE_KEYS.records,
    AUTO_STORAGE_KEYS.state,
    AUTO_STORAGE_KEYS.log,
    GAME_SETTINGS_KEY,
    SKPORT_STATE_KEY,
    AUTH_STATE_KEY,
  ]);
  const rawSettings = stored[AUTO_STORAGE_KEYS.settings];
  return {
    settings: normalizeAutoSettings(rawSettings),
    gameSettings: migrateGameSettings({
      gameSettings: stored[GAME_SETTINGS_KEY],
      autoSettings: rawSettings,
    }),
    records: stored[AUTO_STORAGE_KEYS.records] ?? {},
    state: stored[AUTO_STORAGE_KEYS.state] ?? {},
    skportState: stored[SKPORT_STATE_KEY] ?? {},
    authState: normalizeAuthState(stored[AUTH_STATE_KEY]),
    log: Array.isArray(stored[AUTO_STORAGE_KEYS.log])
      ? stored[AUTO_STORAGE_KEYS.log]
      : [],
  };
}

async function writeAutoSettings(settings) {
  await chrome.storage.local.set({
    [AUTO_STORAGE_KEYS.settings]: settings,
  });
}

// Persists the per-game settings and mirrors the effective
// automation values into the legacy HoYoLAB switches.
async function writeGameSettings(data) {
  const games = {};
  for (const id of GAME_IDS) {
    if (GAME_INFO[id].platform !== "hoyolab") continue;
    games[id] = isGameAutomationEffective(data.gameSettings, id);
  }
  await chrome.storage.local.set({
    [GAME_SETTINGS_KEY]: data.gameSettings,
    [AUTO_STORAGE_KEYS.settings]: { ...data.settings, games },
  });
  data.settings = normalizeAutoSettings(data.settings, data.gameSettings);
}

// One row per game: icon (with a text-dot fallback when the icon
// file is not packaged), the label, and the display / automation
// switches. Hidden games keep their row here — this list is the
// settings screen — but disappear from the status area and from
// every scheduled run.
function renderGameSettings(data) {
  const rows = GAME_IDS.map((id) => {
    const info = GAME_INFO[id];
    const row = document.createElement("div");
    row.className = "game-row";

    const icon = document.createElement("img");
    icon.className = "game-icon";
    icon.src = info.icon;
    icon.alt = "";
    icon.addEventListener("error", () => {
      const dot = document.createElement("span");
      dot.className = "game-dot";
      dot.textContent = info.label.slice(0, 1);
      icon.replaceWith(dot);
    });
    row.append(icon);

    const label = document.createElement("span");
    label.className = "game-label";
    label.textContent = info.label;
    row.append(label);

    const displayLabel = document.createElement("label");
    displayLabel.className = "mini-toggle";
    const displayInput = document.createElement("input");
    displayInput.type = "checkbox";
    displayInput.className = "switch-input";
    displayInput.dataset.game = id;
    displayInput.dataset.switch = "display";
    displayInput.checked = data.gameSettings.display[id];
    const displaySwitch = document.createElement("span");
    displaySwitch.className = "switch";
    displaySwitch.setAttribute("aria-hidden", "true");
    displayLabel.append(
      displayInput,
      displaySwitch,
      document.createTextNode("表示")
    );
    row.append(displayLabel);

    const autoLabel = document.createElement("label");
    autoLabel.className = "mini-toggle";
    const autoInput = document.createElement("input");
    autoInput.type = "checkbox";
    autoInput.className = "switch-input";
    autoInput.dataset.game = id;
    autoInput.dataset.switch = "automation";
    autoInput.checked = data.gameSettings.automation[id];
    autoInput.disabled =
      !data.settings.enabled || !data.gameSettings.display[id];
    const autoSwitch = document.createElement("span");
    autoSwitch.className = "switch";
    autoSwitch.setAttribute("aria-hidden", "true");
    autoLabel.append(autoInput, autoSwitch, document.createTextNode("自動"));
    row.append(autoLabel);

    return row;
  });
  gameSettingsBox.replaceChildren(...rows);
}

// The Endfield sanity reading the worker cached, shown only while
// the game is visible (#6). The refresh button asks the worker for
// a fresh reading; viewing works with automation off.
function renderGameStatus(data) {
  gameStatusBox.replaceChildren();
  if (!data.gameSettings.display.endfield) return;

  const sanity = data.skportState.sanity;
  const box = document.createElement("div");
  box.className = "sanity-box";

  const head = document.createElement("p");
  head.className = "hint";
  head.textContent = "アークナイツ：エンドフィールドの理性";
  box.append(head);

  if (sanity && typeof sanity.current === "number") {
    const row = document.createElement("div");
    row.className = "sanity-row";
    const bar = document.createElement("div");
    bar.className = "sanity-bar";
    const fill = document.createElement("div");
    fill.className = "sanity-fill";
    const percent =
      sanity.max > 0
        ? Math.min(100, Math.round((sanity.current / sanity.max) * 100))
        : 0;
    fill.style.width = `${percent}%`;
    bar.append(fill);
    const text = document.createElement("span");
    text.textContent = `${sanity.current} / ${sanity.max}`;
    row.append(bar, text);
    box.append(row);

    const note = document.createElement("p");
    note.className = "hint";
    if (sanity.current >= sanity.max) {
      note.textContent = "満タンです。";
    } else if (typeof sanity.fullAt === "number") {
      const mins = Math.max(
        0,
        Math.round((sanity.fullAt - Date.now()) / 60000)
      );
      const hours = Math.floor(mins / 60);
      const rest = mins % 60;
      const span =
        hours > 0 ? `約${hours}時間${rest}分` : `約${rest}分`;
      note.textContent = `満タンまで${span}${sanity.estimated ? "（推定）" : ""}・${timeFormat.format(new Date(sanity.at))} 時点`;
    } else {
      note.textContent = `${timeFormat.format(new Date(sanity.at))} 時点`;
    }
    box.append(note);
  } else {
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = data.skportState.sessionMissing
      ? "Skport にログインすると理性が表示されます。"
      : "まだ取得していません。下のボタンで取得できます。";
    box.append(note);
  }

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "btn-secondary";
  refresh.id = "sanity-refresh";
  refresh.textContent = "理性を更新";
  box.append(refresh);

  const link = document.createElement("a");
  link.className = "text-link";
  link.href = "https://game.skport.com/endfield/sign-in";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "Skport を開く";
  box.append(link);

  gameStatusBox.replaceChildren(box);
}

// The login-expired banner (#10): shown while the shared auth
// state says a provider's login is gone, one block per provider,
// each with the button that opens the login page. It hides
// itself once a run succeeds again, because the runners clear
// the state.
function renderAuthBanner(data) {
  authBanner.hidden = !anyAuthExpired(data.authState);
  authBannerHoyolab.hidden = !isAuthExpired(data.authState, "hoyolab");
  authBannerSkport.hidden = !isAuthExpired(data.authState, "skport");
}

function renderAuto(data) {
  renderAuthBanner(data);
  autoEnabled.checked = data.settings.enabled;
  renderGameSettings(data);
  renderGameStatus(data);
  renderHistory(data);

  const riskControl = data.state.riskControl || data.skportState.riskControl;
  if (!data.settings.enabled) {
    setStatus(autoStatus, "オフになっています。", null);
  } else if (riskControl) {
    setStatus(
      autoStatus,
      "公式の認証（パズル）が必要になったため、自動処理を止めています。公式ページで一度手動でチェックインしてから、「今すぐ実行」を押してください。",
      "ng"
    );
  } else if (data.state.sessionMissing && data.skportState.sessionMissing) {
    setStatus(
      autoStatus,
      "HoYoLAB / Skport にログインしていないため、自動処理を実行できていません。",
      "ng"
    );
  } else if (data.state.sessionMissing) {
    setStatus(
      autoStatus,
      "HoYoLAB にログインしていないため、HoYoLAB の自動処理を実行できていません。",
      "ng"
    );
  } else if (data.skportState.sessionMissing) {
    setStatus(
      autoStatus,
      "Skport にログインしていないため、エンドフィールドの自動処理を実行できていません。",
      "ng"
    );
  } else {
    const parts = [];
    if (data.state.lastCheckinRunAt) {
      parts.push(
        `チェックイン最終実行: ${timeFormat.format(new Date(data.state.lastCheckinRunAt))}`
      );
    }
    if (data.skportState.lastCheckinRunAt) {
      parts.push(
        `エンドフィールド最終実行: ${timeFormat.format(new Date(data.skportState.lastCheckinRunAt))}`
      );
    }
    if (data.state.lastCodeRunAt) {
      parts.push(
        `コード確認最終実行: ${timeFormat.format(new Date(data.state.lastCodeRunAt))}`
      );
    }
    setStatus(
      autoStatus,
      parts.length > 0 ? parts.join(" / ") : "まだ実行していません。",
      "ok"
    );
  }

  const total = countSuccessfulRedeems(data.records);
  const monthly = countSuccessfulRedeems(
    data.records,
    jstMonthKey(new Date())
  );
  autoCounts.textContent =
    total > 0
      ? `交換できたコード: 今月 ${monthly} 件 / 通算 ${total} 件`
      : "";

  if (data.log.length === 0) {
    const item = document.createElement("li");
    item.textContent =
      "まだ実行履歴がありません。「今すぐ実行」を押すと今すぐ試せます。";
    autoLog.replaceChildren(item);
  } else {
    autoLog.replaceChildren(
      ...data.log.slice(-10).reverse().map(renderLogEntry)
    );
  }
}

const LOG_KIND_LABELS = {
  checkin: "チェックイン",
  redeem: "コード交換",
  auth: "ログイン",
  system: "お知らせ",
};

// The shared outcome hints mention HoYoLAB; Endfield entries get
// Skport-specific wording for the outcomes they can produce.
const ENDFIELD_OUTCOME_HINTS = {
  failed:
    "時間をおいて「今すぐ実行」を押すか、Skport 公式ページで一度手動でチェックインすると直ることがあります",
  not_logged_in: "Skport にログインしてから開き直してください",
  risk_control:
    "Skport 公式ページで認証を完了してから「今すぐ実行」を押してください",
  rate_limited: "混雑しています。しばらく待つと自動で再試行します",
  no_role:
    "エンドフィールドのキャラクターが Skport アカウントに見つかりませんでした。遊んでいないゲームはオフにしてください",
};

const LOG_OK_OUTCOMES = new Set(["success", "already_done", "already_used"]);
const LOG_NG_OUTCOMES = new Set([
  "failed",
  "not_logged_in",
  "risk_control",
  "fetch_failed",
]);

function renderLogEntry(entry) {
  const item = document.createElement("li");
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = LOG_KIND_LABELS[entry.kind] ?? "お知らせ";
  item.append(kind);

  const when = timeFormat.format(new Date(entry.at));
  const game = entry.game ? GAME_INFO[entry.game]?.label ?? "" : "";
  const code = entry.code ? ` ${entry.code}` : "";
  item.append(document.createTextNode(` ${when} ${game}${code} — `));

  const outcome = document.createElement("span");
  outcome.textContent = describeAutoOutcome(entry.outcome);
  if (LOG_OK_OUTCOMES.has(entry.outcome)) {
    outcome.className = "ok";
  } else if (LOG_NG_OUTCOMES.has(entry.outcome)) {
    outcome.className = "ng";
  } else {
    outcome.className = "muted";
  }
  item.append(outcome);

  if (typeof entry.detail === "string" && entry.detail !== "") {
    item.append(document.createTextNode(`（${entry.detail}）`));
  }

  const hint =
    entry.game === "endfield"
      ? ENDFIELD_OUTCOME_HINTS[entry.outcome] ?? ""
      : describeAutoOutcomeHint(entry.outcome);
  if (hint !== "") {
    const hintLine = document.createElement("div");
    hintLine.className = "entry-hint";
    hintLine.textContent = hint;
    item.append(hintLine);
  }
  return item;
}

// Receipt history (#15): the check-in / redemption entries of
// the run log as a readable list behind the history button. The
// model (lib/popup-view) picks the entries; this only renders.
function renderHistoryEntry(entry) {
  const item = document.createElement("li");
  const kind = document.createElement("span");
  kind.className = "kind";
  kind.textContent = LOG_KIND_LABELS[entry.kind] ?? "お知らせ";
  item.append(kind);

  const when = timeFormat.format(new Date(entry.at));
  const game = entry.game ? GAME_INFO[entry.game]?.label ?? "" : "";
  const code = entry.code ? ` ${entry.code}` : "";
  item.append(document.createTextNode(` ${when} ${game}${code} — `));

  const outcome = document.createElement("span");
  outcome.textContent = describeAutoOutcome(entry.outcome);
  if (LOG_OK_OUTCOMES.has(entry.outcome)) {
    outcome.className = "ok";
  } else if (LOG_NG_OUTCOMES.has(entry.outcome)) {
    outcome.className = "ng";
  } else {
    outcome.className = "muted";
  }
  item.append(outcome);

  if (entry.detail) {
    item.append(document.createTextNode(`（${entry.detail}）`));
  }
  return item;
}

function renderHistory(data) {
  const entries = buildHistoryEntries(data.log);
  if (entries.length === 0) {
    const item = document.createElement("li");
    item.textContent = "まだ受け取り履歴がありません。";
    historyList.replaceChildren(item);
    return;
  }
  historyList.replaceChildren(...entries.map(renderHistoryEntry));
}

// The history toggle swaps its label with the state （表示 ⇄
// 閉じる) on top of the shared collapsible wiring (#26).
wireCollapsible(historyButton, historyBox, (open) => {
  historyButtonLabel.textContent = historyToggleLabel(open);
});

async function refreshAuto() {
  try {
    renderAuto(await readAutoData());
  } catch {
    setStatus(autoStatus, "状態を読み込めませんでした。", "ng");
  }
}

autoEnabled.addEventListener("change", async () => {
  const data = await readAutoData();
  data.settings.enabled = autoEnabled.checked;
  await writeAutoSettings(data.settings);
  await refreshAuto();
});

gameSettingsBox.addEventListener("change", async (event) => {
  const input = event.target;
  const gameId = input?.dataset?.game;
  const switchName = input?.dataset?.switch;
  if (!gameId || !switchName) return;
  const data = await readAutoData();
  data.gameSettings[switchName][gameId] = input.checked;
  await writeGameSettings(data);
  await refreshAuto();
});

gameStatusBox.addEventListener("click", async (event) => {
  if (event.target?.id !== "sanity-refresh") return;
  const button = event.target;
  button.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "skport:refreshSanity" });
  } catch {
    // The worker answers when the refresh finishes; a closed
    // channel just means we re-read the state below.
  } finally {
    button.disabled = false;
    await refreshAuto();
  }
});

autoRunNow.addEventListener("click", async () => {
  autoRunNow.disabled = true;
  setStatus(autoStatus, "実行しています…", null);
  try {
    await chrome.runtime.sendMessage({ type: "auto:runNow" });
  } catch {
    // The worker answers when the run finishes; a closed channel
    // just means we re-read the state below.
  } finally {
    autoRunNow.disabled = false;
    await refreshAuto();
  }
});

refreshAuto();
