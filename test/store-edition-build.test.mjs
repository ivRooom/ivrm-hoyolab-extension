// Tests for scripts/build-store-edition.mjs (issue #4).
//
// The build is exercised against small fixture source trees in a
// temp directory, never against the real tree, so the cases stay
// hermetic: placeholder fallback, linked status module, manifest
// shape, and the forbidden-string guard.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(
  new URL("../scripts/build-store-edition.mjs", import.meta.url)
);

function runBuild(root, out) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, "--root", root, "--out", out],
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
      }
    );
  });
}

async function makeFixture(t, { popupJs = "// store popup fixture\n" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "store-edition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src", "store"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "fixture", version: "9.9.9" })
  );
  await writeFile(
    path.join(root, "src", "store", "popup.html"),
    '<link rel="stylesheet" href="popup.css" />\n' +
      '<img src="../mascot.webp" alt="" />\n' +
      '<script type="module" src="popup.js"></script>\n'
  );
  await writeFile(path.join(root, "src", "store", "popup.js"), popupJs);
  await writeFile(path.join(root, "src", "store", "popup.css"), "body {}\n");
  await writeFile(
    path.join(root, "src", "store", "status-placeholder.mjs"),
    'export const LINK_TOKEN_STORAGE_KEY = "portalLinkToken";\n' +
      'export async function fetchLinkSummary() { return { kind: "unavailable" }; }\n'
  );
  await writeFile(path.join(root, "src", "header-banner.webp"), "banner");
  await writeFile(path.join(root, "src", "mascot.webp"), "mascot");
  return root;
}

async function listAll(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listAll(full, base)));
    else files.push(path.relative(base, full));
  }
  return files.sort();
}

test("placeholder build: manifest shape, file set, exclusions", async (t) => {
  const root = await makeFixture(t);
  const out = path.join(root, "out");
  const run = await runBuild(root, out);
  assert.equal(run.code, 0, run.stderr);

  const manifest = JSON.parse(await readFile(path.join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "9.9.9");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.host_permissions, ["https://api.ivrm.jp/*"]);
  assert.equal("background" in manifest, false);
  assert.equal(manifest.action.default_popup, "src/store/popup.html");

  const info = JSON.parse(await readFile(path.join(out, "BUILD-INFO.json"), "utf8"));
  assert.equal(info.statusModule, "placeholder");

  const files = await listAll(out);
  assert.deepEqual(files, [
    "BUILD-INFO.json",
    "manifest.json",
    "src/header-banner.webp",
    "src/lib/hoyolab-link.mjs",
    "src/mascot.webp",
    "src/store/popup.css",
    "src/store/popup.html",
    "src/store/popup.js",
  ]);
  // The copied status module is the placeholder, and no automation
  // artifact is anywhere in the package.
  const lib = await readFile(path.join(out, "src", "lib", "hoyolab-link.mjs"), "utf8");
  assert.match(lib, /unavailable/);
  for (const file of files) {
    assert.ok(!file.includes("hoyolab-auto"), file);
    assert.ok(!file.includes("background"), file);
    assert.ok(!file.includes("icon-"), file);
  }
});

test("linked build: real status module is picked up when present", async (t) => {
  const root = await makeFixture(t);
  await mkdir(path.join(root, "src", "lib"), { recursive: true });
  const realModule =
    'export async function fetchLinkSummary() { return { kind: "ok", rows: [], updatedAt: null }; }\n';
  await writeFile(path.join(root, "src", "lib", "hoyolab-link.mjs"), realModule);

  const out = path.join(root, "out");
  const run = await runBuild(root, out);
  assert.equal(run.code, 0, run.stderr);

  const info = JSON.parse(await readFile(path.join(out, "BUILD-INFO.json"), "utf8"));
  assert.equal(info.statusModule, "linked");
  const lib = await readFile(path.join(out, "src", "lib", "hoyolab-link.mjs"), "utf8");
  assert.equal(lib, realModule);
});

test("forbidden content in a store source fails the build", async (t) => {
  const root = await makeFixture(t, {
    popupJs: 'const api = "https://sg-act-novel-api.hoyolab.com/event/luna/os/sign";\n',
  });
  const out = path.join(root, "out");
  const run = await runBuild(root, out);
  assert.notEqual(run.code, 0);
  assert.match(run.stderr, /forbidden string/);
});
