import {
  buildHoyolabCookieString,
  describeExchangeResult,
  isPairingTokenShape,
  PAIRING_EXCHANGE_URL,
} from "./lib/hoyolab-cookie.mjs";

const sessionStatus = document.getElementById("session-status");
const tokenInput = document.getElementById("pairing-token");
const linkButton = document.getElementById("link-button");
const result = document.getElementById("result");

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
    if (described.ok) tokenInput.value = "";
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

refreshSessionStatus();
