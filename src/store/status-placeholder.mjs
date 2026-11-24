// Placeholder for the portal link-summary helpers (issue #3 /
// ivrm-web #1675), used by the store-edition build until the real
// src/lib/hoyolab-link.mjs lands on this branch.
//
// It implements the exact interface the store popup imports, but
// performs no network access: fetchLinkSummary always reports
// { kind: "unavailable" }, which the popup renders as a "status
// view coming soon" note. The build script records
// statusModule: "placeholder" in BUILD-INFO.json whenever this
// file is used, so a placeholder package can never be mistaken
// for a submittable one. When the real module appears in
// src/lib/, the build picks it up automatically and this file is
// no longer copied.

export const LINK_SUMMARY_URL =
  "https://api.ivrm.jp/member/hoyolab/link-summary";
export const LINK_TOKEN_STORAGE_KEY = "portalLinkToken";

export async function fetchLinkSummary() {
  return { kind: "unavailable" };
}

// Same display contract as the real helper: "たった今" / "12分前" /
// "3時間前" / "2日前" for an ISO stamp, null when unparseable.
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
