import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Review state is a cache, not repository data: it lives outside the
// repository in the platform's cache directory, in one readable directory per
// opened path, like pi's session storage:
//
//   ~/.cache/rv/--home-user-repo--/state.json    (Linux)
//   ~/Library/Caches/rv/--Users-you-repo--/state.json  (macOS)
//
// RV_CACHE_DIR overrides the location, mostly for tests.
//
// Cache files are never migrated. Bump VERSION whenever their format changes;
// files from other versions are ignored, so rv starts from scratch.
const VERSION = 2;

function cacheDir() {
  if (process.platform === "darwin")
    return path.join(os.homedir(), "Library", "Caches", "rv");
  if (process.platform === "win32")
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "rv",
      "cache",
    );
  return path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
    "rv",
  );
}

// Encode an absolute path the way pi names its session directories: keep it
// readable, but flat, by replacing separators with dashes.
export function stateDir(root, base = process.env.RV_CACHE_DIR || cacheDir()) {
  const encoded = `--${root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(base, encoded);
}

export function statePath(root) {
  return path.join(stateDir(root), "state.json");
}

function agentSessionPath(root) {
  return path.join(stateDir(root), "agent.json");
}

async function readCacheFile(file, root) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    // Path encoding is lossy (/a/b-c and /a/b/c encode the same), so a
    // mismatched root means the file belongs to another repository.
    if (data?.version !== VERSION || data.root !== root) return null;
    // version/root describe the cache file, not the data it holds.
    const { version, root: _, ...rest } = data;
    return rest;
  } catch {
    return null;
  }
}

async function writeCacheFile(file, root, data) {
  await mkdir(path.dirname(file), { recursive: true });
  // Atomic write: a crash or concurrent reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: VERSION, root, ...data }));
  await rename(tmp, file);
}

export function loadState(root) {
  return readCacheFile(statePath(root), root);
}

export function saveState(root, state) {
  return writeCacheFile(statePath(root), root, state);
}

export function loadAgentSession(root) {
  return readCacheFile(agentSessionPath(root), root);
}

export function saveAgentSession(root, session) {
  return writeCacheFile(agentSessionPath(root), root, session);
}

export async function clearAgentSession(root, token) {
  // The readable directory encoding is lossy. Never remove a colliding
  // repository's live-session descriptor. Cleanup is best-effort; stale
  // descriptors are rejected by the status check before the next session.
  if ((await loadAgentSession(root))?.token === token)
    await rm(agentSessionPath(root), { force: true }).catch(() => {});
}
