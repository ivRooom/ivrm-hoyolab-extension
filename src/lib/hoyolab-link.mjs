// Pure helpers for the portal link summary — the "current status"
// section of the popup (resin / trailblaze power / exploration).
// Kept free of chrome.* APIs so they can be unit-tested with plain
// node --test.
//
// When the pairing exchange succeeds, the portal may include a
// read-only link token (ivrm-web #1675; the feature is gated
// server-side). The popup stores it in chrome.storage.local and
// presents it as a Bearer token to the summary endpoint — the only
// request it authorizes. The token is bound server-side to the
// member's registered HoYoLAB credential: re-pairing (which
// replaces the credential) or unregistering revokes it, and the
// endpoint then answers 401, which the popup turns into a
// "please link again" hint.

export const LINK_SUMMARY_URL =
  "https://api.ivrm.jp/member/hoyolab/link-summary";
export const LINK_TOKEN_STORAGE_KEY = "portalLinkToken";

const SUMMARY_GAMES = [
  {
    id: "genshin",
    label: "原神",
    icon: "icon-genshin.png",
    metricLabel: "樹脂",
    currentKey: "resinCurrent",
    maxKey: "resinMax",
  },
  {
    id: "starrail",
    label: "崩壊：スターレイル",
    icon: "icon-starrail.png",
    metricLabel: "開拓力",
    currentKey: "trailblazeCurrent",
    maxKey: "trailblazeMax",
  },
];

// Bar width for a current/max pair; null when the pair cannot be
// shown as a bar (non-numbers, or a non-positive max).
export function summaryBarPercent(current, max) {
  if (typeof current !== "number" || typeof max !== "number" || max <= 0)
    return null;
  return Math.min(100, Math.max(0, Math.round((current / max) * 100)));
}

// Maps the summary response body to render rows. A game the member
// has not registered (null) and a game whose metric pair is
// incomplete are both skipped — the section shows what exists and
// nothing invented. Exploration rides along when present.
export function buildLinkSummaryRows(body) {
  if (
    !body ||
    body.ok !== true ||
    typeof body.games !== "object" ||
    body.games === null
  )
    return [];
  const rows = [];
  for (const game of SUMMARY_GAMES) {
    const entry = body.games[game.id];
    if (!entry) continue;
    const current = entry[game.currentKey];
    const max = entry[game.maxKey];
    if (typeof current !== "number" || typeof max !== "number") continue;
    rows.push({
      id: game.id,
      label: game.label,
      icon: game.icon,
      metricLabel: game.metricLabel,
      current,
      max,
      percent: summaryBarPercent(current, max),
      explorationPercent:
        typeof entry.explorationPercent === "number"
          ? entry.explorationPercent
          : null,
    });
  }
  return rows;
}

// The fresher of the two update stamps (notes are fetched live,
// progress is refreshed on a timer); null when neither exists.
export function pickLinkSummaryUpdatedAt(body) {
  const updatedAt = body?.updatedAt;
  if (!updatedAt || typeof updatedAt !== "object") return null;
  const stamps = [updatedAt.notes, updatedAt.progress].filter(
    (value) => typeof value === "string" && !Number.isNaN(Date.parse(value))
  );
  if (stamps.length === 0) return null;
  return stamps.sort().at(-1);
}

// "たった今" / "12分前" / "3時間前" / "2日前" for an ISO stamp;
// null for anything unparseable.
export function formatRelativeTime(iso, nowMs) {
  if (typeof iso !== "string") return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const diffMs = Math.max(0, nowMs - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "たった今";
  if (minutes < 60) return `${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}時間前`;
  return `${Math.floor(hours / 24)}日前`;
}

// One fetch against the summary endpoint, classified for the
// popup: ok (with rows), unauthorized (the token was revoked —
// re-pairing fixes it), or failed (network, server, or a body
// shape this build does not understand).
export async function fetchLinkSummary(fetchFn, token) {
  let response;
  try {
    response = await fetchFn(LINK_SUMMARY_URL, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    return { kind: "failed" };
  }
  if (response.status === 401) return { kind: "unauthorized" };
  if (response.status !== 200) return { kind: "failed" };
  let body = null;
  try {
    body = await response.json();
  } catch {
    return { kind: "failed" };
  }
  if (!body || body.ok !== true) return { kind: "failed" };
  return {
    kind: "ok",
    rows: buildLinkSummaryRows(body),
    updatedAt: pickLinkSummaryUpdatedAt(body),
  };
}
