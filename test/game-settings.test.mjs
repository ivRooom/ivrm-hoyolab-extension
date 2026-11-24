import assert from "node:assert/strict";
import test from "node:test";
import {
  automationGameIds,
  defaultGameSettings,
  isGameAutomationEffective,
  isGameAutomationOn,
  isGameVisible,
  migrateGameSettings,
  normalizeGameSettings,
  visibleGameIds,
} from "../src/lib/game-settings.mjs";
import { normalizeAutoSettings } from "../src/lib/hoyolab-auto.mjs";

// The per-game settings model (#6): defaults, defensive
// normalization, migration from the legacy autoSettings switches,
// and the effective-automation rule (display && automation).

test("defaults show every game and enable automation per game", () => {
  const settings = defaultGameSettings();
  assert.deepEqual(visibleGameIds(settings), [
    "genshin",
    "starrail",
    "zzz",
    "endfield",
  ]);
  assert.deepEqual(automationGameIds(settings), [
    "genshin",
    "starrail",
    "zzz",
    "endfield",
  ]);
});

test("normalization keeps booleans and drops junk", () => {
  assert.deepEqual(normalizeGameSettings(undefined), defaultGameSettings());
  assert.deepEqual(normalizeGameSettings("junk"), defaultGameSettings());
  const settings = normalizeGameSettings({
    display: { zzz: false, genshin: "yes" },
    automation: { endfield: false },
  });
  assert.equal(settings.display.zzz, false);
  assert.equal(settings.display.genshin, true);
  assert.equal(settings.automation.endfield, false);
  assert.equal(settings.automation.genshin, true);
});

test("a hidden game is excluded from automation even when its automation switch is on", () => {
  const settings = normalizeGameSettings({
    display: { genshin: false },
    automation: { genshin: true },
  });
  assert.equal(isGameVisible(settings, "genshin"), false);
  assert.equal(isGameAutomationOn(settings, "genshin"), true);
  assert.equal(isGameAutomationEffective(settings, "genshin"), false);
  assert.deepEqual(automationGameIds(settings), [
    "starrail",
    "zzz",
    "endfield",
  ]);
  assert.deepEqual(visibleGameIds(settings), ["starrail", "zzz", "endfield"]);
});

test("migration without legacy data yields the defaults", () => {
  assert.deepEqual(migrateGameSettings({}), defaultGameSettings());
  assert.deepEqual(migrateGameSettings(undefined), defaultGameSettings());
  assert.deepEqual(
    migrateGameSettings({ gameSettings: null, autoSettings: null }),
    defaultGameSettings()
  );
});

test("migration carries the legacy per-game switches into automation", () => {
  const settings = migrateGameSettings({
    autoSettings: {
      enabled: true,
      games: { genshin: false, starrail: true, zzz: false },
    },
  });
  // The user's legacy choices survive: genshin and zzz stay off.
  assert.equal(settings.automation.genshin, false);
  assert.equal(settings.automation.starrail, true);
  assert.equal(settings.automation.zzz, false);
  // Endfield has no legacy entry and starts on (still gated by the
  // master switch, like any untouched legacy game).
  assert.equal(settings.automation.endfield, true);
  // The legacy UI always showed every game, so display starts on.
  assert.deepEqual(settings.display, {
    genshin: true,
    starrail: true,
    zzz: true,
    endfield: true,
  });
});

test("an existing gameSettings value wins over the legacy switches", () => {
  const settings = migrateGameSettings({
    gameSettings: {
      display: { endfield: false },
      automation: { genshin: true },
    },
    autoSettings: { enabled: true, games: { genshin: false } },
  });
  assert.equal(settings.automation.genshin, true);
  assert.equal(settings.display.endfield, false);
});

test("the HoYoLAB settings normalization applies the per-game override", () => {
  const legacy = { enabled: true, games: { genshin: true, zzz: true } };
  // Without game settings, legacy behavior is unchanged.
  assert.deepEqual(normalizeAutoSettings(legacy).games, {
    genshin: true,
    starrail: true,
    zzz: true,
  });
  // A hidden game drops out of the effective HoYoLAB switches.
  const withGameSettings = normalizeAutoSettings(legacy, {
    display: { genshin: false },
    automation: { zzz: false },
  });
  assert.equal(withGameSettings.games.genshin, false);
  assert.equal(withGameSettings.games.zzz, false);
  assert.equal(withGameSettings.games.starrail, true);
  assert.equal(withGameSettings.enabled, true);
});
