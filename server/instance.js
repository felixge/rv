import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "./http.js";
import { cacheDir, stateDir } from "./state.js";

const START_TIMEOUT = 15_000;
const STOP_TIMEOUT = 5000;
const LOCK_TIMEOUT = 10_000;
const INITIALIZE_TIMEOUT = 2000;
const cli = fileURLToPath(new URL("../bin/rv.js", import.meta.url));

// Restart using the invoking installation, without version detection. Keep the
// port unless explicitly overridden, so existing browser tabs remain useful.
export async function ensureInstance(root, { port = null } = {}) {
  await requireBuild();
  return withInstanceLock(root, async () => {
    const existing = await runningInstance(root);
    const { failed } = await stopInstances(root);
    if (failed.length) throw new Error(failed.map(({ error }) => error.message).join("; "));
    const nextPort = port ?? (existing ? Number(new URL(existing.url).port) : null);
    return launchInstance(root, nextPort);
  }, "ensure.lock");
}

// Foreground launches retain their own server, but register too. The separate
// startup lock is also used by shutdown, which must finish before a restart.
export async function startInstance(repo, { port = null, host = "127.0.0.1", background = false } = {}) {
  const local = ["127.0.0.1", "localhost"].includes(host);
  const start = async () => {
    if (background) await requireBuild();
    const instanceId = randomUUID();
    const server = createApp(repo, { allowRemote: !local, instanceId });
    try {
      try {
        await listen(server, { port: port ?? 4444, host: local ? "127.0.0.1" : host });
      } catch (error) {
        if (error.code !== "EADDRINUSE" || port !== null) throw error;
        await listen(server, { port: 0, host: local ? "127.0.0.1" : host });
      }
      const instance = {
        root: repo.root,
        pid: process.pid,
        url: `http://localhost:${server.address().port}`,
        instanceId,
      };
      server.on("error", (error) => console.error(`rv: ${error.message}`));
      const stop = () => server.close();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      server.once("close", () => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        if (local) unregister(instance).catch((error) =>
          console.error(`rv: ${error.message}`));
      });
      if (local) await publish(instance);
      return { instance, server };
    } catch (error) {
      server.close();
      throw error;
    }
  };
  // Remote servers are not registered for automatic management.
  return local ? withInstanceLock(repo.root, start) : start();
}

export async function listInstances() {
  const base = cacheDir();
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) =>
    readInstances(path.join(base, entry.name))))).flat();
  const instances = await Promise.all(records.map((instance) => probeInstance(instance, instance.root)));
  const unique = new Map(instances.filter(Boolean).map((instance) => [instance.instanceId, instance]));
  return [...unique.values()].sort((a, b) => a.root.localeCompare(b.root) || a.pid - b.pid);
}

export async function stopInstances(root = null) {
  const instances = (await listInstances()).filter((instance) => root === null || instance.root === root);
  const stopped = [], failed = [];
  await Promise.all(instances.map(async (instance) => {
    try {
      const result = await stopInstance(instance);
      if (result) stopped.push(result);
    } catch (error) {
      failed.push({ root: instance.root, error });
    }
  }));
  stopped.sort((a, b) => a.root.localeCompare(b.root) || a.pid - b.pid);
  failed.sort((a, b) => a.root.localeCompare(b.root));
  return { stopped, failed };
}

export function instanceDir(root) {
  // Keep readable names, but unlike review-state paths distinguish paths such
  // as /a/b-c and /a/b/c. Bound the name so deep roots still fit on disk.
  const legacy = stateDir(root);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 16);
  let readable = "";
  for (const char of path.basename(legacy)) {
    if (Buffer.byteLength(readable + char) > 160) break;
    readable += char;
  }
  return path.join(path.dirname(legacy), `${readable}${hash}`);
}

async function stopInstance(instance) {
  const root = instance.root;
  const stopped = await withInstanceLock(root, async () => {
    // Revalidate under the lock: discovery may have raced with another stop,
    // startup, or a crash. Never signal a PID from stale metadata alone.
    const record = (await readInstances(instanceDir(root))).find((current) =>
      current.instanceId === instance.instanceId);
    const current = await probeInstance(record, root);
    if (!current) return null;
    try {
      process.kill(current.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + STOP_TIMEOUT;
    while (await probeInstance(current, root)) {
      if (Date.now() >= deadline)
        throw new Error(`Timed out stopping PID ${current.pid}; SIGTERM was sent.`);
      await delay(50);
    }
    await removeRegistration(current);
    return current;
  });
  if (!stopped) return null;
  // Graceful shutdown also takes the lock to unregister. Release it before
  // waiting for the process to finish draining requests and exit.
  const deadline = Date.now() + STOP_TIMEOUT;
  while (processAlive(stopped.pid)) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for PID ${stopped.pid} to exit; SIGTERM was sent.`);
    await delay(50);
  }
  return stopped;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function runningInstance(root) {
  for (const instance of await readInstances(instanceDir(root))) {
    const running = await probeInstance(instance, root);
    if (running) return running;
  }
  return null;
}

async function readInstances(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const names = entries.filter((name) => name === "instance.json" || /^instance-[0-9a-f-]{36}\.json$/.test(name));
  names.sort((a, b) => a === "instance.json" ? -1 : b === "instance.json" ? 1 : a.localeCompare(b));
  const records = await Promise.all(names.map(async (name) => {
    const instance = await readMetadata(path.join(dir, name));
    if (typeof instance?.root !== "string" || !path.isAbsolute(instance.root) ||
        path.resolve(instanceDir(instance.root)) !== path.resolve(dir) ||
        (name !== "instance.json" && name !== `instance-${instance.instanceId}.json`)) return null;
    return instance;
  }));
  return records.filter(Boolean);
}

async function probeInstance(instance, root) {
  if (!instance || instance.root !== root ||
      !Number.isInteger(instance.pid) || instance.pid <= 0 || instance.pid > 0x7fffffff ||
      typeof instance.instanceId !== "string" || !instance.instanceId)
    return null;
  try {
    const url = new URL(instance.url);
    // Never let corrupted metadata direct a request off the local machine.
    if (url.protocol !== "http:" || url.hostname !== "localhost" ||
        !url.port || url.origin !== instance.url) return null;
    const request = (route) => fetch(`http://127.0.0.1:${url.port}/api/${route}`, {
      headers: { "X-RV": "1" },
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    // This endpoint remains available even if the repository is removed.
    // Earlier servers expose their identity on info instead.
    let response = await request("instance");
    if (response.status === 404) response = await request("info");
    if (!response.ok) return null;
    const info = await response.json();
    return info.root === root && info.instanceId === instance.instanceId &&
      (info.pid === undefined || info.pid === instance.pid) ? instance : null;
  } catch {
    return null;
  }
}

async function readInstance(root) {
  return readMetadata(path.join(instanceDir(root), "instance.json"));
}

async function readMetadata(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function publish(instance) {
  // Foreground launches may intentionally open another server for the same
  // scope. Keep all of them discoverable instead of overwriting the first.
  const primary = await probeInstance(await readInstance(instance.root), instance.root);
  const name = primary ? `instance-${instance.instanceId}.json` : "instance.json";
  const file = path.join(instanceDir(instance.root), name);
  const tmp = `${file}.${instance.instanceId}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(instance, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function unregister(instance) {
  await withInstanceLock(instance.root, () => removeRegistration(instance));
}

async function removeRegistration(instance) {
  for (const name of ["instance.json", `instance-${instance.instanceId}.json`]) {
    const file = path.join(instanceDir(instance.root), name);
    const current = await readMetadata(file);
    if (current?.root === instance.root && current.instanceId === instance.instanceId)
      await unlink(file);
  }
}

async function withInstanceLock(root, operation, name = "startup.lock") {
  const dir = instanceDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, name);
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + LOCK_TIMEOUT;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await reapLock(lock);
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${lock}`);
      await delay(50);
    }
  }
  try {
    await writeFile(path.join(lock, "owner.json"), JSON.stringify(owner), { mode: 0o600, flag: "wx" });
    return await operation();
  } finally {
    try {
      const current = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
      if (current.token === owner.token)
        await rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function reapLock(lock) {
  const abandoned = await staleLock(lock);
  if (!abandoned) return;
  const claim = path.join(lock, "reaping");
  try {
    // Only one waiter may reap a stale directory. Recheck after claiming it:
    // another waiter could have already replaced it with a fresh lock.
    await mkdir(claim);
  } catch (error) {
    if (error.code === "EEXIST") {
      if (await staleLock(claim)) await rm(claim, { recursive: true, force: true });
      return;
    }
    if (error.code === "ENOENT") return;
    throw error;
  }
  let discarded;
  try {
    await writeFile(path.join(claim, "owner.json"), JSON.stringify({ pid: process.pid }));
    const current = await stat(lock);
    // Creating the reaping directory changes its parent's mtime. Preserve the
    // initial age check, but verify this is still the same abandoned directory.
    if (current.dev === abandoned.dev && current.ino === abandoned.ino &&
        await staleLock(lock, true)) {
      discarded = `${lock}.${randomUUID()}.stale`;
      await rename(lock, discarded);
      await rm(discarded, { recursive: true, force: true });
    }
  } catch (error) {
    // A newer owner may have released its lock while we were rechecking it.
    if (error.code !== "ENOENT") throw error;
  } finally {
    if (!discarded) await rm(claim, { recursive: true, force: true });
  }
}

async function staleLock(lock, ageChecked = false) {
  let info;
  try {
    info = await stat(lock);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
    if (Number.isInteger(owner?.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return null;
      } catch (error) {
        if (error.code === "ESRCH") return info;
        if (error.code === "EPERM") return null;
        throw error;
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  // A crash between mkdir and writing the owner must be recoverable, without
  // mistaking a lock that is still being initialized for an abandoned one.
  return ageChecked || Date.now() - info.mtimeMs >= INITIALIZE_TIMEOUT ? info : null;
}

async function launchInstance(root, port) {
  const dir = instanceDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const logfile = path.join(dir, "server.log");
  const log = await open(logfile, "a", 0o600);
  let child;
  try {
    child = fork(cli, [
      root, "--no-open", "--ensure-server",
      ...(port === null ? [] : ["--port", String(port)]),
    ], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", log.fd, log.fd, "ipc"],
      windowsHide: true,
    });
    child.unref();
    return await new Promise((resolve, reject) => {
      const finish = (error, instance) => {
        clearTimeout(timer);
        child.removeListener("message", message);
        child.removeListener("error", failed);
        child.removeListener("exit", exited);
        if (child.connected) child.disconnect();
        if (error) reject(error);
        else resolve(instance);
      };
      const message = (value) => {
        if (value?.error) finish(new Error(value.error));
        else if (value?.instance) finish(null, value.instance);
      };
      const failed = (error) => finish(error);
      const exited = (code, signal) =>
        finish(new Error(`Background server exited (${signal || code}).`));
      const timer = setTimeout(() =>
        finish(new Error("Timed out starting the background server.")), START_TIMEOUT);
      child.once("message", message);
      child.once("error", failed);
      child.once("exit", exited);
    });
  } catch (error) {
    child?.kill("SIGTERM");
    throw new Error(`${error.message} See ${logfile}`);
  } finally {
    await log.close();
  }
}

async function requireBuild() {
  try {
    await access(new URL("../dist/index.html", import.meta.url));
  } catch {
    throw new Error("UI build is missing. Run npm run build first.");
  }
}

function listen(server, options) {
  server.listen(options);
  return once(server, "listening");
}
