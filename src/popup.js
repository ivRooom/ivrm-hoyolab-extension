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
  fetchLinkSummary,
  formatRelativeTime,
  LINK_TOKEN_STORAGE_KEY,
} from "./lib/hoyolab-link.mjs";
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
} from "./lib/game-settings.mjs";
import {
  AUTH_STATE_KEY,
  anyAuthExpired,
  isAuthExpired,
  normalizeAuthState,
} from "./lib/session-resilience.mjs";

const SKPORT_STATE_KEY = "skportState";

const sessionStatus = document.getElementById("session-status");
const tokenInput = document.getElementById("pairing-token");
const linkButton = document.getElementById("link-button");
const autoLinkButton = document.getElementById("auto-link-button");
const result = document.getElementById("result");
const linkState = document.getElementById("link-state");

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
      setStatus(sessionStatus, "ログインを検出しました。", "ok");
    } else {
      setStatus(
        sessionStatus,
        "ログインが検出できません。HoYoLAB にログインしてから開き直してください。",
        "ng"
      );
    }
  } catch {
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

function summaryHint(text) {
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = text;
  return hint;
}

function renderSummaryRow(row) {
  const item = document.createElement("div");
  item.className = "summary-row";
  const icon = document.createElement("img");
  icon.className = "game-icon";
  icon.src = row.icon;
  icon.alt = "";
  item.append(icon);

  const main = document.createElement("div");
  main.className = "summary-main";
  const line = document.createElement("div");
  line.className = "summary-line";
  const name = document.createElement("span");
  name.textContent = row.label;
  const value = document.createElement("span");
  value.className = "summary-value";
  value.textContent = `${row.metricLabel} ${row.current} / ${row.max}`;
  line.append(name, value);
  main.append(line);

  if (row.percent !== null) {
    const meter = document.createElement("div");
    meter.className = "meter";
    const fill = document.createElement("div");
    fill.className = "meter-fill";
    fill.style.width = `${row.percent}%`;
    meter.append(fill);
    main.append(meter);
  }
  if (row.explorationPercent !== null) {
    const sub = document.createElement("div");
    sub.className = "summary-sub";
    sub.textContent = `探索度 ${row.explorationPercent.toFixed(1)}%`;
    main.append(sub);
  }
  item.append(main);
  return item;
}

function renderLinkSummary(result) {
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
  if (result.rows.length === 0) {
    summaryBody.replaceChildren(
      summaryHint("まだ表示できるデータがありません。ポータルにデータが届くと、ここにも表示されます。")
    );
    return;
  }
  const children = result.rows.map(renderSummaryRow);
  const relative = formatRelativeTime(result.updatedAt, Date.now());
  if (relative) {
    const stamp = document.createElement("p");
    stamp.className = "hint";
    stamp.textContent = `最終更新: ${relative}`;
    children.push(stamp);
  }
  summaryBody.replaceChildren(...children);
}

async function refreshLinkSummary() {
  let stored = {};
  try {
    stored = await chrome.storage.local.get([
      LINK_TOKEN_STORAGE_KEY,
      "portalLinkedAt",
    ]);
  } catch {
    stored = {};
  }
  const token = stored[LINK_TOKEN_STORAGE_KEY];
  if (typeof token === "string" && token !== "") {
    summarySection.hidden = false;
    summaryRefresh.hidden = false;
    summaryBody.replaceChildren(summaryHint("読み込んでいます…"));
    renderLinkSummary(
      await fetchLinkSummary((url, init) => fetch(url, init), token)
    );
    return;
  }
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
    displayInput.dataset.game = id;
    displayInput.dataset.switch = "display";
    displayInput.checked = data.gameSettings.display[id];
    displayLabel.append(displayInput, document.createTextNode("表示"));
    row.append(displayLabel);

    const autoLabel = document.createElement("label");
    autoLabel.className = "mini-toggle";
    const autoInput = document.createElement("input");
    autoInput.type = "checkbox";
    autoInput.dataset.game = id;
    autoInput.dataset.switch = "automation";
    autoInput.checked = data.gameSettings.automation[id];
    autoInput.disabled =
      !data.settings.enabled || !data.gameSettings.display[id];
    autoLabel.append(autoInput, document.createTextNode("自動"));
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
  refresh.className = "secondary";
  refresh.id = "sanity-refresh";
  refresh.textContent = "理性を更新";
  box.append(refresh);

  const link = document.createElement("a");
  link.className = "link-button";
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
