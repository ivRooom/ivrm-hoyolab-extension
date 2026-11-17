// Pure helpers for the HoYoLAB session handoff. Kept free of
// chrome.* APIs so they can be unit-tested with plain node --test.
//
// The extension reads the HoYoLAB cookies of the browser profile
// the user is already signed in with, picks exactly the session
// values the ivRooom API validates (ltuid_v2 / ltoken_v2, plus
// ltmid_v2 when present), and sends them — together with the
// pairing token the user minted in the portal — to the pairing
// exchange endpoint. Nothing is stored anywhere in the extension.

// Cookie names in the order they are serialized. The first two
// are the required pair; ltmid_v2 rides along because HoYoLAB may
// require it as a companion value.
export const HOYOLAB_SESSION_COOKIE_NAMES = [
  "ltuid_v2",
  "ltoken_v2",
  "ltmid_v2",
];
export const HOYOLAB_REQUIRED_COOKIE_NAMES = ["ltuid_v2", "ltoken_v2"];

export const PAIRING_EXCHANGE_URL =
  "https://api.ivrm.jp/hoyolab-pairing/exchange";

// Picks the session cookies out of a chrome.cookies.getAll result.
// The same name can appear for several domains (the parent domain
// and host-only entries); the parent-domain entry wins, then the
// first non-empty value. Returns a Map in the fixed name order,
// containing only names that were found with a non-empty value.
export function selectHoyolabSessionCookies(cookies) {
  const selected = new Map();
  for (const name of HOYOLAB_SESSION_COOKIE_NAMES) {
    const candidates = cookies.filter(
      (cookie) => cookie.name === name && cookie.value !== ""
    );
    if (candidates.length === 0) continue;
    const preferred =
      candidates.find((cookie) => cookie.domain === ".hoyolab.com") ??
      candidates[0];
    selected.set(name, preferred.value);
  }
  return selected;
}

// Serializes the selected cookies into the Cookie header value the
// API expects, or returns null when the required pair is
// incomplete (the user is not signed in to HoYoLAB, or the session
// is not a v2 session).
export function buildHoyolabCookieString(cookies) {
  const selected = selectHoyolabSessionCookies(cookies);
  for (const name of HOYOLAB_REQUIRED_COOKIE_NAMES) {
    if (!selected.has(name)) return null;
  }
  return [...selected.entries()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

// A pairing token is two base64url segments joined by a dot. This
// is a shape check only — the API verifies the signature and the
// expiry, and its answer is what the popup reports.
export function isPairingTokenShape(value) {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.trim());
}

// Maps an exchange response to the message the popup shows. The
// API's error bodies never contain credential material, and this
// mapping never echoes the token or the cookie either.
export function describeExchangeResult(status, body) {
  if (status === 200 && body?.registered === true) {
    return { ok: true, message: "連携しました。ポータルで樹脂や開拓力が表示されます。" };
  }
  if (status === 401) {
    return {
      ok: false,
      message:
        "ペアリングコードが無効か、期限切れです。ポータルで新しいコードを発行してください。",
    };
  }
  if (status === 422) {
    return {
      ok: false,
      message:
        "HoYoLAB のログイン情報が揃っていません。HoYoLAB にログインし直してからお試しください。",
    };
  }
  if (status === 404) {
    return {
      ok: false,
      message: "メンバー情報が見つかりませんでした。ポータルにログインできているか確認してください。",
    };
  }
  return {
    ok: false,
    message: "連携できませんでした。しばらくしてからもう一度お試しください。",
  };
}
