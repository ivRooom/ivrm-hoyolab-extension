// Auto-link with the portal (ivrm-hoyolab-extension #14; the
// portal side is ivrm-web #1740, PR #1742).
//
// The pairing-code flow asks the member to copy a code out of the
// portal and paste it into the popup. Auto-link removes the copy
// step: the popup's primary button opens the portal's dedicated
// link page, the member confirms there (the consent click is what
// mints the token, under the portal session), and the page hands
// the token to this extension inside the browser.
//
// Bridge contract (fixed by the portal side —
// apps/member/lib/member-hoyolab-link-model.mjs in ivrm-web):
//   - The page dispatches a window CustomEvent named
//     AUTO_LINK_BRIDGE_EVENT_TYPE, only after the consent click
//     and a successful mint.
//   - detail is { version: 1, pairingToken, expiresAt }.
//     expiresAt is an ISO string or null.
//   - The token never touches the DOM (no attribute, input, or
//     text); it travels in the event detail only.
//   - The token itself is the same 600-second signed bearer the
//     code flow uses; only the transport changes.
//
// The content script (src/auto-link-content.js) runs only on the
// link page, validates the detail with the same rules as
// parseAutoLinkBridgeDetail below, and forwards the token to the
// background with chrome.runtime.sendMessage. The background then
// runs the SAME pairing exchange the manual code entry runs
// (lib/hoyolab-cookie.mjs): it reads the HoYoLAB session cookies
// at that moment and posts them with the token. Nothing about the
// exchange, the stored link token, or the credential handling
// differs between the two flows.
//
// Pure module: chrome.* and fetch are injected, so node --test
// drives everything with fakes, like the other lib modules.

import {
  describeExchangeResult,
  extractLinkToken,
  isPairingTokenShape,
  PAIRING_EXCHANGE_URL,
} from "./hoyolab-cookie.mjs";

export const AUTO_LINK_PAGE_URL =
  "https://member.ivrm.jp/profile/hoyolab-link";

export const AUTO_LINK_BRIDGE_EVENT_TYPE = "ivrm-hoyolab-pairing-token";
export const AUTO_LINK_BRIDGE_VERSION = 1;
export const AUTO_LINK_MESSAGE_TYPE = "autoLink:pairingToken";

// Storage keys for the link record. portalLinkedAt predates this
// module (the popup has written it since the pairing feature
// shipped); the display name key is new with the exchange's
// displayName field (ivrm-web #1740 W2).
export const LINKED_AT_STORAGE_KEY = "portalLinkedAt";
export const LINKED_DISPLAY_NAME_STORAGE_KEY = "portalLinkedDisplayName";

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

// Receiver-side validation of the bridge detail — the same rules
// the portal's parseMemberHoyolabLinkBridgeDetail applies.
// Unknown versions are dropped (a future contract change raises
// the version and is agreed explicitly). Returns the clean
// { pairingToken, expiresAt } or null.
export function parseAutoLinkBridgeDetail(value) {
  if (!isRecord(value)) return null;
  if (value.version !== AUTO_LINK_BRIDGE_VERSION) return null;
  if (
    typeof value.pairingToken !== "string" ||
    !isPairingTokenShape(value.pairingToken) ||
    !isNullableString(value.expiresAt)
  ) {
    return null;
  }
  return { pairingToken: value.pairingToken, expiresAt: value.expiresAt };
}

// Validation of the content script's message to the background.
// The token is re-checked here (the background trusts no sender),
// and only the token crosses — expiresAt was for the page's own
// bookkeeping.
export function parseAutoLinkTokenMessage(message) {
  if (!isRecord(message)) return null;
  if (message.type !== AUTO_LINK_MESSAGE_TYPE) return null;
  if (
    typeof message.pairingToken !== "string" ||
    !isPairingTokenShape(message.pairingToken)
  ) {
    return null;
  }
  return { pairingToken: message.pairingToken };
}

// The background accepts the hand-off only from a tab showing
// the link page. The content script is registered for exactly
// that URL, and this check keeps the guarantee even if a message
// is imitated from elsewhere.
export function isAutoLinkPageUrl(url) {
  return typeof url === "string" && url.startsWith(AUTO_LINK_PAGE_URL);
}

// The exchange success body may carry the linked member's portal
// display name (ivrm-web #1740 W2) so the popup can say WHO was
// linked. Fail-soft by design on the server (a name that cannot
// be resolved simply omits the field), so absence is normal and
// yields null here.
export function extractDisplayName(status, body) {
  if (status !== 200 || body?.registered !== true) return null;
  const name = body.displayName;
  if (typeof name !== "string" || name.trim() === "") return null;
  return name;
}

// Creates the background's token handler. Deps:
//   fetchJson(url, { method, body }) -> { status, body }
//     (the background's adapter; it JSON-encodes the body)
//   getCookieString() -> the HoYoLAB session cookie string, or
//     null when no usable session exists
//   now() -> ms timestamp for the link record
// The handler resolves to a result object; persisting the link
// record (portalLinkedAt / link token / display name) and the log
// entry is the caller's job, using the fields returned here.
export function createAutoLinkHandler(deps) {
  return async function handlePairingToken(pairingToken) {
    if (
      typeof pairingToken !== "string" ||
      !isPairingTokenShape(pairingToken)
    ) {
      return {
        ok: false,
        reason: "invalid_token",
        message:
          "ペアリングコードの形が違います。ポータルの連携ページからやり直してください。",
      };
    }
    let cookie;
    try {
      cookie = await deps.getCookieString();
    } catch {
      cookie = null;
    }
    if (!cookie) {
      return {
        ok: false,
        reason: "no_session",
        message:
          "HoYoLAB のログインが検出できません。ログインしてからお試しください。",
      };
    }
    let status;
    let body;
    try {
      ({ status, body } = await deps.fetchJson(PAIRING_EXCHANGE_URL, {
        method: "POST",
        body: { pairingToken, cookie },
      }));
    } catch {
      return {
        ok: false,
        reason: "network",
        message:
          "通信できませんでした。ネットワークを確認してもう一度お試しください。",
      };
    }
    const described = describeExchangeResult(status, body);
    if (!described.ok) {
      return {
        ok: false,
        reason: "exchange_failed",
        status,
        message: described.message,
      };
    }
    return {
      ok: true,
      message: described.message,
      linkToken: extractLinkToken(status, body),
      displayName: extractDisplayName(status, body),
      linkedAt: deps.now(),
    };
  };
}

// The execution-log entry for one auto-link attempt, in the shape
// the popup's log renderer already understands (kind "system",
// outcome success/failed, the user-facing message as the detail).
// The token and the cookie never appear in it.
export function buildAutoLinkLogEntry(result, at) {
  return {
    at,
    kind: "system",
    outcome: result?.ok ? "success" : "failed",
    detail: result?.ok
      ? "自動連携でポータルと連携しました"
      : "自動連携に失敗しました",
  };
}
