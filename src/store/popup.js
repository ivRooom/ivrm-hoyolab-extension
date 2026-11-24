// Store-edition popup (issue #4): read-only status display.
//
// The only state is the portal link token the member pastes in,
// kept in chrome.storage.local. The only network call is the
// portal summary endpoint, made through the helpers in
// ../lib/hoyolab-link.mjs (in a placeholder build those helpers
// report the view as unavailable and nothing is fetched).
//
// This file intentionally uses no cookie or alarm APIs and never
// talks to any game-service domain; the build script verifies
// that for the whole package.

import {
  LINK_TOKEN_STORAGE_KEY,
  fetchLinkSummary,
  formatRelativeTime,
} from "../lib/hoyolab-link.mjs";

const tokenInput = document.getElementById("link-token");
const linkState = document.getElementById("link-state");
const saveButton = document.getElementById("save-token");
const clearButton = document.getElementById("clear-token");
const rowsBox = document.getElementById("status-rows");
const statusMessage = document.getElementById("status-message");
const statusUpdated = document.getElementById("status-updated");
const refreshButton = document.getElementById("refresh");

// Text markers instead of the official app artwork: the store
// edition ships no game art at all.
const GAME_MARKERS = {
  genshin: "原",
  starrail: "ス",
};

function setStatus(element, text, kind) {
  element.textContent = text;
  element.classList.remove("ok", "ng");
  if (kind) element.classList.add(kind);
}

async function loadToken() {
  try {
    const stored = await chrome.storage.local.get([LINK_TOKEN_STORAGE_KEY]);
    const token = stored[LINK_TOKEN_STORAGE_KEY];
    return typeof token === "string" && token !== "" ? token : null;
  } catch {
    return null;
  }
}

function renderLinkState(hasToken) {
  if (hasToken) {
    setStatus(linkState, "連携トークンが保存されています。", "ok");
  } else {
    setStatus(
      linkState,
      "未連携です。ポータルで発行した連携トークンを貼り付けてください。",
      null
    );
  }
}

function renderRows(rows) {
  rowsBox.replaceChildren(
    ...rows.map((row) => {
      const box = document.createElement("div");
      box.className = "game-row";

      const head = document.createElement("div");
      head.className = "game-head";
      const marker = document.createElement("span");
      marker.className = "marker";
      marker.textContent = GAME_MARKERS[row.id] ?? row.label.slice(0, 1);
      const label = document.createElement("span");
      label.className = "game-label";
      label.textContent = row.label;
      const value = document.createElement("span");
      value.className = "game-value";
      value.textContent = `${row.metricLabel} ${row.current} / ${row.max}`;
      head.append(marker, label, value);
      box.append(head);

      if (typeof row.percent === "number") {
        const bar = document.createElement("div");
        bar.className = "bar";
        const fill = document.createElement("div");
        fill.className = "bar-fill";
        fill.style.width = `${row.percent}%`;
        bar.append(fill);
        box.append(bar);
      }
      if (typeof row.explorationPercent === "number") {
        const explore = document.createElement("p");
        explore.className = "hint";
        explore.textContent = `探索度 ${row.explorationPercent}%`;
        box.append(explore);
      }
      return box;
    })
  );
}

async function refresh() {
  const token = await loadToken();
  renderLinkState(token !== null);
  rowsBox.replaceChildren();
  statusUpdated.textContent = "";
  if (!token) {
    setStatus(
      statusMessage,
      "連携すると、ここに樹脂と開拓力の状況が表示されます。",
      null
    );
    return;
  }
  setStatus(statusMessage, "取得しています…", null);
  const result = await fetchLinkSummary(fetch, token);
  if (result.kind === "ok") {
    if (result.rows.length === 0) {
      setStatus(
        statusMessage,
        "表示できるステータスがまだありません。ポータル側でゲーム連携とデータ取得が済むと表示されます。",
        null
      );
    } else {
      renderRows(result.rows);
      setStatus(statusMessage, "", null);
    }
    const relative = result.updatedAt
      ? formatRelativeTime(result.updatedAt, Date.now())
      : null;
    statusUpdated.textContent = relative ? `最終取得: ${relative}` : "";
  } else if (result.kind === "unauthorized") {
    setStatus(
      statusMessage,
      "連携トークンが無効になっています。ポータルで連携し直して、新しいトークンを貼ってください。",
      "ng"
    );
  } else if (result.kind === "unavailable") {
    setStatus(
      statusMessage,
      "ステータス表示は準備中です。連携トークンの保存のみ利用できます。",
      null
    );
  } else {
    setStatus(
      statusMessage,
      "取得できませんでした。ネットワークを確認して「更新する」を押してください。",
      "ng"
    );
  }
}

saveButton.addEventListener("click", async () => {
  const token = tokenInput.value.trim();
  if (token === "") {
    setStatus(linkState, "トークンが入力されていません。", "ng");
    return;
  }
  try {
    await chrome.storage.local.set({ [LINK_TOKEN_STORAGE_KEY]: token });
    tokenInput.value = "";
    await refresh();
  } catch {
    setStatus(linkState, "保存できませんでした。", "ng");
  }
});

clearButton.addEventListener("click", async () => {
  try {
    await chrome.storage.local.remove([LINK_TOKEN_STORAGE_KEY]);
  } catch {
    // Re-render below either way; a failed remove just means the
    // next open shows the token again.
  }
  tokenInput.value = "";
  await refresh();
});

refreshButton.addEventListener("click", () => {
  void refresh();
});

void refresh();
