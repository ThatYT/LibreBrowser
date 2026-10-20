#!/usr/bin/env node
/**
 * CI gate: every rrweb-family package across the workspace must
 * be pinned to ONE identical exact version. Record and replay MUST match — skew produces a
 * *silent blank replay*, so we make it loud. A PR bumping one @rrweb/* package alone fails here.
 *
 * Checks both the declared manifests (exact pins, no ranges) and — when node_modules exists —
 * the actually-resolved installed versions.
 */
import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RRWEB = /^(@rrweb\/|rrweb$|rrweb-)/;
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const errors = [];
const declared = new Map(); // "pkgName@where" -> version

function checkManifest(manifestPath) {
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!RRWEB.test(name)) continue;
      if (!EXACT.test(spec)) {
        errors.push(`${manifestPath}: ${name}@"${spec}" — rrweb packages must be EXACT pins`);
      }
      declared.set(`${name} (${manifestPath})`, spec);
    }
  }
}

checkManifest(join(root, "package.json"));
const pkgsDir = join(root, "packages");
for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
  const manifest = join(pkgsDir, entry.name, "package.json");
  if (entry.isDirectory() && existsSync(manifest)) checkManifest(manifest);
}

const declaredVersions = new Set(declared.values());
if (declaredVersions.size > 1) {
  errors.push(
    `Declared rrweb versions diverge: ${[...declared.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
}

// Resolved check: what actually landed on disk.
const resolved = new Map();
function scanInstalled(nmDir) {
  const scoped = join(nmDir, "@rrweb");
  if (!existsSync(scoped)) return;
  for (const entry of readdirSync(scoped, { withFileTypes: true })) {
    const manifest = join(scoped, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const { name, version } = JSON.parse(readFileSync(manifest, "utf8"));
    const prev = resolved.get(name);
    if (prev !== undefined && prev !== version) {
      errors.push(`Installed ${name} resolves to both ${prev} and ${version}`);
    }
    resolved.set(name, version);
  }
}
scanInstalled(join(root, "node_modules"));
for (const entry of readdirSync(pkgsDir, { withFileTypes: true })) {
  if (entry.isDirectory()) scanInstalled(join(pkgsDir, entry.name, "node_modules"));
}
const resolvedVersions = new Set(resolved.values());
if (resolvedVersions.size > 1) {
  errors.push(
    `Installed rrweb versions diverge: ${[...resolved.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
}
if (declaredVersions.size === 1 && resolvedVersions.size === 1) {
  const [d] = declaredVersions;
  const [r] = resolvedVersions;
  if (d !== r) errors.push(`Declared ${d} but installed ${r} — run pnpm install`);
}

// OOPIF-CORE-AGENT relies on @rrweb/record's plugin getMirror hook to expose the recorder's
// live cross-origin iframe id translator. Keep this exact installed-2.1.1 path loud: the agent
// cannot resolve unified ids into child-frame-local ids without it.
const recordLink = join(root, "packages/agent/node_modules/@rrweb/record");
if (!existsSync(recordLink)) {
  errors.push(`${recordLink}: installed @rrweb/record is missing — run pnpm install`);
} else {
  const recordDir = realpathSync(recordLink);
  const recordManifest = JSON.parse(readFileSync(join(recordDir, "package.json"), "utf8"));
  const recordDistPath = join(recordDir, "dist/record.js");
  if (recordManifest.version !== "2.1.1") {
    errors.push(`${recordDir}: OOPIF mirror accessor is verified only against @rrweb/record 2.1.1`);
  } else if (!existsSync(recordDistPath)) {
    errors.push(`${recordDistPath}: missing installed rrweb record dist`);
  } else {
    const recordDist = readFileSync(recordDistPath, "utf8");
    const accessorTokens = [
      "class CrossOriginIframeMirror",
      '"iframeIdToRemoteIdMap"',
      '"iframeRemoteIdToIdMap"',
      "getRemoteId(iframe, id",
      "if (plugin.getMirror)",
      "crossOriginIframeMirror: iframeManager.crossOriginIframeMirror",
    ];
    const missing = accessorTokens.filter((token) => !recordDist.includes(token));
    if (missing.length > 0) {
      errors.push(
        `${recordDistPath}: OOPIF plugins[].getMirror accessor path changed; missing ${missing.join(
          ", ",
        )}`,
      );
    }
  }
}

if (errors.length > 0) {
  console.error("rrweb version check FAILED:\n" + errors.map((e) => `  - ${e}`).join("\n"));
  console.error(
    "\nAll @rrweb/* packages (record, replay, types, canvas-webrtc plugins) move in LOCKSTEP.",
  );
  process.exit(1);
}
const version = [...declaredVersions][0] ?? "(none declared)";
console.log(
  `rrweb version check OK: ${declared.size} declarations, all @ ${version}; OOPIF mirror accessor present`,
);
