import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const WATCHER = fileURLToPath(new URL("../mods/freebuff-status/freebuff-watcher.mjs", import.meta.url));

function fields(text) {
  const match = /\x1b\]7501;([^\x1b]*)\x1b\\/.exec(text);
  if (!match) return null;
  const out = {};
  for (const part of match[1].split(":")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at);
    const value = part.slice(at + 1);
    out[key] = key === "title" || key === "msg" ? Buffer.from(value, "base64").toString("utf8") : value;
  }
  return out;
}

async function waitFor(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("the watcher reports idle before any chat exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "freebuff-watcher-"));
  const tty = join(root, "tty");
  const cwd = join(root, "demo-project");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(cwd);
  mkdirSync(join(root, "projects"));
  writeFileSync(tty, "");

  const child = spawn(process.execPath, [WATCHER], {
    cwd,
    env: {
      ...process.env,
      HC_TERMINAL_ID: "t-test",
      FREEBUFF_HERDR_STATUS_TTY: tty,
      FREEBUFF_HERDR_PROJECTS_DIR: join(root, "projects"),
      HERDR_FREEBUFF_PID: String(process.pid),
      FREEBUFF_HERDR_DEBUG: "",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  try {
    const text = await waitFor(() => {
      try {
        return readFileSync(tty, "utf8") || null;
      } catch {
        return null;
      }
    });
    assert.ok(text, "the watcher wrote no report");
    assert.deepEqual(fields(text), {
      state: "idle",
      app: "freebuff",
      title: "demo-project",
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.on("exit", resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
