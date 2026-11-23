// Per-game settings model (ivrm-hoyolab-extension #6): every game
// has two independent switches —
//
//   display:     whether the game appears in the popup at all
//   automation:  whether the daily automation may act for it
//
// A game whose display switch is off disappears from both popup
// sections and is excluded from every scheduled run, even when its
// automation switch is on: the effective automation state is
// display && automation.
//
// Storage: chrome.storage.local key "gameSettings". The model
// predates this file — the HoYoLAB automation used to keep a single
// per-game switch in "autoSettings" (hoyolab-auto.mjs). Migration
// (migrateGameSettings) derives the new model from that legacy
// shape when no gameSettings exist yet, so an existing user's
// choices carry over: the legacy per-game switch becomes the
// automation switch, and display starts on for every game (the
// legacy UI always showed every game).
//
// Pure module: no chrome.* APIs, no fetch, unit-tested with plain
// node --test like the other lib modules.

// ----------------------------------------------------------------
// Game registry (all games, across platforms)

export const GAME_IDS = ["genshin", "starrail", "zzz", "endfield"];

export const GAME_INFO = {
  genshin: {
    id: "genshin",
    label: "原神",
    platform: "hoyolab",
    icon: "icon-genshin.png",
  },
  starrail: {
    id: "starrail",
    label: "崩壊：スターレイル",
    platform: "hoyolab",
    icon: "icon-starrail.png",
  },
  zzz: {
    id: "zzz",
    label: "ゼンレスゾーンゼロ",
    platform: "hoyolab",
    icon: "icon-zzz.png",
  },
  endfield: {
    id: "endfield",
    label: "アークナイツ：エンドフィールド",
    platform: "skport",
    icon: "icon-endfield.png",
  },
};

export const GAME_SETTINGS_KEY = "gameSettings";

// ----------------------------------------------------------------
// Settings shape

export function defaultGameSettings() {
  const display = {};
  const automation = {};
  for (const id of GAME_IDS) {
    display[id] = true;
    automation[id] = true;
  }
  return { display, automation };
}

function normalizeSwitchMap(raw, defaults) {
  const map = { ...defaults };
  if (raw && typeof raw === "object") {
    for (const id of GAME_IDS) {
      if (typeof raw[id] === "boolean") map[id] = raw[id];
    }
  }
  return map;
}

export function normalizeGameSettings(raw) {
  const defaults = defaultGameSettings();
  if (!raw || typeof raw !== "object") return defaults;
  return {
    display: normalizeSwitchMap(raw.display, defaults.display),
    automation: normalizeSwitchMap(raw.automation, defaults.automation),
  };
}

// Builds the effective settings from whatever is in storage. When
// a gameSettings value exists it wins outright; otherwise the
// legacy autoSettings per-game switches become the automation
// switches (HoYoLAB games only — Endfield has no legacy entry and
// starts with automation on, still gated by the master switch,
// exactly like a legacy game the user never touched).
export function migrateGameSettings(stored) {
  const { gameSettings, autoSettings } = stored ?? {};
  if (gameSettings && typeof gameSettings === "object") {
    return normalizeGameSettings(gameSettings);
  }
  const settings = defaultGameSettings();
  const legacyGames = autoSettings?.games;
  if (legacyGames && typeof legacyGames === "object") {
    for (const id of GAME_IDS) {
      if (GAME_INFO[id].platform !== "hoyolab") continue;
      if (typeof legacyGames[id] === "boolean") {
        settings.automation[id] = legacyGames[id];
      }
    }
  }
  return settings;
}

// ----------------------------------------------------------------
// Queries

export function isGameVisible(settings, gameId) {
  return normalizeGameSettings(settings).display[gameId] === true;
}

export function isGameAutomationOn(settings, gameId) {
  return normalizeGameSettings(settings).automation[gameId] === true;
}

// The switch combination that actually lets a scheduled run act
// for a game, and lets the popup show its automation row as on.
export function isGameAutomationEffective(settings, gameId) {
  const normalized = normalizeGameSettings(settings);
  return (
    normalized.display[gameId] === true &&
    normalized.automation[gameId] === true
  );
}

export function visibleGameIds(settings) {
  const normalized = normalizeGameSettings(settings);
  return GAME_IDS.filter((id) => normalized.display[id]);
}

export function automationGameIds(settings) {
  const normalized = normalizeGameSettings(settings);
  return GAME_IDS.filter(
    (id) => normalized.display[id] && normalized.automation[id]
  );
}
