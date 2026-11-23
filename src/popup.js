import {
  buildHoyolabCookieString,
  describeExchangeResult,
  isPairingTokenShape,
  PAIRING_EXCHANGE_URL,
} from "./lib/hoyolab-cookie.mjs";
import {
  AUTO_GAME_IDS,
  AUTO_GAMES,
  AUTO_STORAGE_KEYS,
  countSuccessfulRedeems,
  describeAutoOutcome,
  describeAutoOutcomeHint,
  jstMonthKey,
  normalizeAutoSettings,
} from "./lib/hoyolab-auto.mjs";

const sessionStatus = document.getElementById("session-status");
const tokenInput = document.getElementById("pairing-token");
const linkButton = document.getElementById("link-button");
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
      const linkedAt = Date.now();
      try {
        await chrome.storage.local.set({ portalLinkedAt: linkedAt });
      } catch {
        // Non-fatal: the link itself already succeeded.
      }
      renderLinkState(linkedAt);
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
function renderLinkState(linkedAt) {
  if (typeof linkedAt === "number" && linkedAt > 0) {
    setStatus(
      linkState,
      `ポータル連携済み（${timeFormat.format(new Date(linkedAt))}）`,
      "ok"
    );
  } else {
    linkState.textContent = "";
    linkState.classList.remove("ok", "ng");
  }
}

async function refreshLinkState() {
  try {
    const stored = await chrome.storage.local.get(["portalLinkedAt"]);
    renderLinkState(stored.portalLinkedAt);
  } catch {
    renderLinkState(null);
  }
}

refreshSessionStatus();
refreshLinkState();

// ---------------------------------------------------------------
// Automation (check-in + gift codes). Settings live in
// chrome.storage.local and are read by the service worker on every
// run; this section only edits them and renders the state and log
// the worker leaves behind.

const autoEnabled = document.getElementById("auto-enabled");
const autoStatus = document.getElementById("auto-status");
const autoCounts = document.getElementById("auto-counts");
const autoLog = document.getElementById("auto-log");
const autoRunNow = document.getElementById("auto-run-now");
const autoGameInputs = Object.fromEntries(
  AUTO_GAME_IDS.map((id) => [id, document.getElementById(`auto-game-${id}`)])
);

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
  ]);
  return {
    settings: normalizeAutoSettings(stored[AUTO_STORAGE_KEYS.settings]),
    records: stored[AUTO_STORAGE_KEYS.records] ?? {},
    state: stored[AUTO_STORAGE_KEYS.state] ?? {},
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

function renderAuto(data) {
  autoEnabled.checked = data.settings.enabled;
  for (const id of AUTO_GAME_IDS) {
    autoGameInputs[id].checked = data.settings.games[id];
    autoGameInputs[id].disabled = !data.settings.enabled;
  }

  if (!data.settings.enabled) {
    setStatus(autoStatus, "オフになっています。", null);
  } else if (data.state.riskControl) {
    setStatus(
      autoStatus,
      "公式の認証（パズル）が必要になったため、自動処理を止めています。HoYoLAB の公式ページで一度手動でチェックインしてから、「今すぐ実行」を押してください。",
      "ng"
    );
  } else if (data.state.sessionMissing) {
    setStatus(
      autoStatus,
      "HoYoLAB にログインしていないため、自動処理を実行できていません。",
      "ng"
    );
  } else {
    const parts = [];
    if (data.state.lastCheckinRunAt) {
      parts.push(
        `チェックイン最終実行: ${timeFormat.format(new Date(data.state.lastCheckinRunAt))}`
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
  system: "お知らせ",
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
  const game = entry.game ? AUTO_GAMES[entry.game]?.label ?? "" : "";
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

  const hint = describeAutoOutcomeHint(entry.outcome);
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

for (const id of AUTO_GAME_IDS) {
  autoGameInputs[id].addEventListener("change", async () => {
    const data = await readAutoData();
    data.settings.games[id] = autoGameInputs[id].checked;
    await writeAutoSettings(data.settings);
    await refreshAuto();
  });
}

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
