// Content script for the portal auto-link page (#14). It is
// registered in the manifest for exactly one URL —
// https://member.ivrm.jp/profile/hoyolab-link — and nowhere else.
//
// The page mints a pairing token after the member's consent click
// and dispatches it as a window CustomEvent (the bridge contract
// in lib/auto-link.mjs). This script listens for that event,
// validates the detail, and forwards the token to the background,
// which runs the pairing exchange. The token is never read from
// or written to the DOM here; it only passes through the event
// detail and the runtime message.
//
// Content scripts cannot import the extension's ES modules, so
// the three validation checks duplicate parseAutoLinkBridgeDetail
// in lib/auto-link.mjs. Keep them in step — test/auto-link.test.mjs
// pins both sides to the same event name, version, and token
// pattern.
(() => {
  const EVENT_TYPE = "ivrm-hoyolab-pairing-token";
  const MESSAGE_TYPE = "autoLink:pairingToken";
  const BRIDGE_VERSION = 1;
  const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

  window.addEventListener(EVENT_TYPE, (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
      return;
    }
    if (detail.version !== BRIDGE_VERSION) return;
    if (
      typeof detail.pairingToken !== "string" ||
      !TOKEN_PATTERN.test(detail.pairingToken)
    ) {
      return;
    }
    if (detail.expiresAt !== null && typeof detail.expiresAt !== "string") {
      return;
    }
    // Fire-and-forget: the background answers the popup's state on
    // its next open, and a closed message channel is not an error
    // worth surfacing on the portal page.
    chrome.runtime
      .sendMessage({
        type: MESSAGE_TYPE,
        pairingToken: detail.pairingToken,
        expiresAt: detail.expiresAt,
      })
      .catch(() => {});
  });
})();
