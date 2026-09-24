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

export function agentSessionPath(root) {
  return path.join(stateDir(root), "agent.json");
}

export async function loadState(root) {
  try {
    const state = JSON.parse(await readFile(statePath(root), "utf8"));
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      // Path encoding is lossy (/a/b-c and /a/b/c encode the same), so a
      // mismatched root means the file belongs to another repository.
      state.root !== root
    )
      return null;
    // version/root describe the cache file, not the review state it holds.
    const { version, root: fileRoot, ...rest } = state;
    return rest;
  } catch {
    return null;
  }
}

export async function saveState(root, state) {
  const file = statePath(root);
  await mkdir(path.dirname(file), { recursive: true });
  // Atomic write: a crash or concurrent reader never sees a half-written file.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, root, ...state }));
  await rename(tmp, file);
}

export async function clearState(root) {
  await rm(statePath(root), { force: true });
}

export async function loadAgentSession(root) {
  try {
    const session = JSON.parse(await readFile(agentSessionPath(root), "utf8"));
    if (
      !session ||
      typeof session !== "object" ||
      session.root !== root ||
      typeof session.url !== "string" ||
      typeof session.token !== "string"
    )
      return null;
    return { url: session.url, token: session.token };
  } catch {
    return null;
  }
}

export async function saveAgentSession(root, session) {
  const file = agentSessionPath(root);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, root, ...session }));
  await rename(tmp, file);
}

export async function clearAgentSession(root, token) {
  try {
    const session = JSON.parse(await readFile(agentSessionPath(root), "utf8"));
    // The readable directory encoding is lossy. Never remove a colliding
    // repository's live-session descriptor.
    if (session?.root === root && session.token === token)
      await rm(agentSessionPath(root), { force: true });
  } catch {
    // Session cleanup is best-effort; stale descriptors are rejected by the
    // status check before the next agent session starts.
  }
}
