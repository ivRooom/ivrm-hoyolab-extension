#!/usr/bin/env node
// Builds the Chrome Web Store "read-only" edition of the extension
// (issue #4) into dist/store-edition/.
//
// The store edition is a separate, deliberately smaller product
// built from this same source tree:
//
//   * It shows the member's game status (resin / trailblaze power)
//     that the ivRooom portal already fetched — read-only display.
//   * It never touches HoYoverse: no hoyolab.com / hoyoverse.com
//     host permissions, no `cookies` permission, no `alarms`, no
//     `notifications`, and none of the automation modules
//     (check-in / gift-code redemption / Skport), the auto-link
//     content script, or the login-state reporting are copied
//     into the package. Those features stay in the
//     self-installed edition only.
//   * Its only network destination is the portal API
//     (api.ivrm.jp), authorized by the read-only link token the
//     member pastes in (see ivrm-web #1675 / extension issue #3).
//     The pairing-code exchange is NOT part of the store
//     edition: it posts the member's HoYoLAB session cookie to
//     the portal (a credential write) and needs the `cookies`
//     permission, so the store edition is paste-in only.
//   * Game icons in the store build are text markers, not the
//     official app artwork used by the self-installed edition.
//
// The status data helpers live in src/lib/hoyolab-link.mjs (the
// link-status work of issue #3, now on main). Should that module
// ever go missing from the source tree, the build falls back to
// src/store/status-placeholder.mjs, which implements the same
// interface but reports the status view as unavailable;
// BUILD-INFO.json in the output records which module was used,
// so a placeholder build is never mistaken for the real thing.
//
// Usage:
//   node scripts/build-store-edition.mjs [--root <dir>] [--out <dir>]
//
// The build verifies its own output (manifest shape, referenced
// files present, forbidden strings absent) and fails loudly instead
// of producing a package that would violate the store edition's
// constraints.

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STORE_NAME = "ivRooom 樹脂メモ（非公式）";
export const STORE_TITLE = "ivRooom 樹脂メモ";
export const STORE_DESCRIPTION =
  "ivRooom ポータルと連携して、原神の樹脂と崩壊：スターレイルの開拓力の回復状況を表示する、読み取り専用の非公式ファンメイド拡張機能です。ゲームへの操作は一切行いません。";
export const PORTAL_HOST_PERMISSION = "https://api.ivrm.jp/*";

// Strings that must never appear in the store package. Domains and
// API surface of the automation edition, plus the permission names
// the store edition must not request.
export const FORBIDDEN_PATTERNS = [
  "hoyolab.com",
  "hoyoverse.com",
  "hoyo-codes",
  "chrome.cookies",
  "chrome.alarms",
  "chrome.notifications",
  '"cookies"',
  '"alarms"',
  '"notifications"',
  "hoyolab-auto",
  "AUTO_STORAGE_KEYS",
  "x-rpc-",
  "act_id",
  // Skport (Endfield) automation and its OAuth host.
  "skport",
  "gryphline.com",
  // The credential side of pairing: cookie selection helpers and
  // the exchange endpoint the store edition must never call.
  "hoyolab-cookie",
  "PAIRING_EXCHANGE",
  // Auto-link bridge (content script + CustomEvent hand-off).
  "auto-link",
  "ivrm-hoyolab-pairing-token",
  // Login-state reporting to the portal (#1684) and the
  // session-resilience retry machinery.
  "auth-report",
  "auth-state",
  "session-resilience",
  "game-settings",
];

// Path fragments that must never appear in the store package's
// file list: the official game artwork, the background service
// worker, and every excluded module, whatever its contents say.
// (The linked status module legitimately mentions icon file
// names as data, so artwork is policed here, by file, not by
// string.)
export const FORBIDDEN_FILE_FRAGMENTS = [
  "icon-",
  "background",
  "auto-link",
  "skport",
  "hoyolab-auto",
  "hoyolab-cookie",
  "game-settings",
  "session-resilience",
  "auth-report",
];

const TEXT_EXTENSIONS = new Set([".json", ".html", ".js", ".mjs", ".css", ".txt", ".md"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") args.root = argv[i + 1];
    if (argv[i] === "--out") args.out = argv[i + 1];
  }
  return args;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full, base)));
    } else {
      files.push(path.relative(base, full));
    }
  }
  return files.sort();
}

// The status module is "linked" only when the real helpers from
// issue #3 are present in the source tree; anything else (missing
// file, or a file that does not export the summary fetcher) falls
// back to the placeholder so the build stays honest.
export async function detectStatusModule(root) {
  const candidate = path.join(root, "src", "lib", "hoyolab-link.mjs");
  if (await exists(candidate)) {
    const content = await readFile(candidate, "utf8");
    if (content.includes("fetchLinkSummary")) {
      return { mode: "linked", source: candidate };
    }
  }
  return {
    mode: "placeholder",
    source: path.join(root, "src", "store", "status-placeholder.mjs"),
  };
}

export function buildStoreManifest(version) {
  return {
    manifest_version: 3,
    name: STORE_NAME,
    version,
    description: STORE_DESCRIPTION,
    action: {
      default_popup: "src/store/popup.html",
      default_title: STORE_TITLE,
    },
    permissions: ["storage"],
    host_permissions: [PORTAL_HOST_PERMISSION],
  };
}

export async function verifyStorePackage(out) {
  const problems = [];
  const manifestPath = path.join(out, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new Error("store package manifest.json is missing or unparseable");
  }
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(["storage"])) {
    problems.push(`unexpected permissions: ${JSON.stringify(manifest.permissions)}`);
  }
  if (
    JSON.stringify(manifest.host_permissions) !==
    JSON.stringify([PORTAL_HOST_PERMISSION])
  ) {
    problems.push(
      `unexpected host_permissions: ${JSON.stringify(manifest.host_permissions)}`
    );
  }
  if ("background" in manifest) {
    problems.push("manifest must not declare a background service worker");
  }
  if ("content_scripts" in manifest) {
    problems.push("manifest must not declare content scripts");
  }
  const popupPath = path.join(out, manifest.action?.default_popup ?? "");
  if (!(await exists(popupPath))) {
    problems.push(`popup file missing: ${manifest.action?.default_popup}`);
  } else {
    // Every local file the popup references must be in the package.
    const html = await readFile(popupPath, "utf8");
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((ref) => !ref.startsWith("http") && !ref.startsWith("#"));
    for (const ref of refs) {
      const target = path.join(path.dirname(popupPath), ref);
      if (!(await exists(target))) {
        problems.push(`popup references missing file: ${ref}`);
      }
    }
  }
  const files = await listFiles(out);
  for (const rel of files) {
    for (const fragment of FORBIDDEN_FILE_FRAGMENTS) {
      if (rel.includes(fragment)) {
        problems.push(`forbidden file "${rel}" in package (matches "${fragment}")`);
      }
    }
    if (!TEXT_EXTENSIONS.has(path.extname(rel))) continue;
    const content = await readFile(path.join(out, rel), "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (content.includes(pattern)) {
        problems.push(`forbidden string "${pattern}" found in ${rel}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`store package verification failed:\n- ${problems.join("\n- ")}`);
  }
  return files;
}

export async function buildStoreEdition({ root, out }) {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const status = await detectStatusModule(root);

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const copies = [
    ["src/store/popup.html", "src/store/popup.html"],
    ["src/store/popup.js", "src/store/popup.js"],
    ["src/store/popup.css", "src/store/popup.css"],
    // Generated illustrations (not official artwork).
    ["src/header-banner.webp", "src/header-banner.webp"],
    ["src/mascot.webp", "src/mascot.webp"],
  ];
  for (const [from, to] of copies) {
    const source = path.join(root, from);
    if (!(await exists(source))) {
      throw new Error(`required source file missing: ${from}`);
    }
    const target = path.join(out, to);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }

  const libTarget = path.join(out, "src", "lib", "hoyolab-link.mjs");
  await mkdir(path.dirname(libTarget), { recursive: true });
  await cp(status.source, libTarget);

  const manifest = buildStoreManifest(pkg.version);
  await writeFile(
    path.join(out, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await writeFile(
    path.join(out, "BUILD-INFO.json"),
    `${JSON.stringify(
      {
        edition: "chrome-web-store-read-only",
        version: pkg.version,
        statusModule: status.mode,
        builtAt: new Date().toISOString(),
        note:
          status.mode === "placeholder"
            ? "Placeholder build: src/lib/hoyolab-link.mjs (issue #3) is not in this source tree yet, so the status view reports itself as unavailable. Do not submit this build."
            : "Status module linked from src/lib/hoyolab-link.mjs.",
      },
      null,
      2
    )}\n`
  );

  const files = await verifyStorePackage(out);
  return { files, statusMode: status.mode, version: pkg.version };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = args.root ? path.resolve(args.root) : path.resolve(scriptDir, "..");
  const out = args.out
    ? path.resolve(args.out)
    : path.join(root, "dist", "store-edition");
  const result = await buildStoreEdition({ root, out });
  console.log(`store edition ${result.version} built at ${out}`);
  console.log(`status module: ${result.statusMode}`);
  for (const file of result.files) console.log(`  ${file}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
