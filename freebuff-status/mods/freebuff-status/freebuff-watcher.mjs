#!/usr/bin/env node
/**
 * Freebuff -> Herdr status bridge.
 *
 * Freebuff has no plugin API and no headless mode, so this watcher reads the
 * chat log Freebuff already writes and reports the turn state to Herdr with
 * OSC 7501. It is started by the `freebuff` wrapper that `status.mjs install`
 * writes, only inside a Herdr terminal (`HC_TERMINAL_ID`).
 *
 * Design rules:
 *   - Out of band: it never sits between the keyboard and Freebuff.
 *   - Incremental: it reads only new bytes of one log, never the whole file.
 *   - Exact session: it follows the chat written by this Freebuff process
 *     (`HERDR_FREEBUFF_PID`), not "the newest chat".
 *   - Silent outside Herdr, and with `FREEBUFF_HERDR_STATUS=0`.
 */

import { watch } from "node:fs";
import { basename } from "node:path";

import {
  DEFAULT_ROOT,
  createClassifier,
  createLogReader,
  fallbackTitle,
  findChatByPid,
  newestChat,
  pidTree,
  readChatTitle,
} from "./freebuff-log.mjs";
import { PLUGIN_ID, createReporter } from "./herdr-report.mjs";

const DEBUG = process.env.FREEBUFF_HERDR_DEBUG === "1";

function debug(message) {
  if (!DEBUG) return;
  try {
    process.stderr.write(`[${PLUGIN_ID}] ${message}\n`);
  } catch {
    // stderr is gone; nothing useful to do
  }
}

const env = process.env;
const reporter = createReporter({ env, debug });

if (!reporter.enabled) {
  debug(statusReason(env));
  process.exit(0);
}

const root = env.FREEBUFF_HERDR_PROJECTS_DIR || DEFAULT_ROOT;
const pid = Number(env.HERDR_FREEBUFF_PID) || process.ppid;
const project = basename(process.cwd());
const startedAt = Date.now();

// How long to wait for the pid match before falling back to the newest chat.
// The pid tree normally matches in the first tick, so this is only a safety
// net for an unusual install.
const FALLBACK_MS = 5000;

let chat = null;
let reader = null;
let classifier = null;
let logWatcher = null;
let titleSettled = false;
let matchedByPid = false;
let lastAliveCheck = 0;
let lastPidSearch = 0;
let pids = [];
let lastPidRefresh = 0;

function statusReason(current) {
  if (current.HC_TERMINAL_ID) return "disabled by FREEBUFF_HERDR_STATUS";
  return "not inside a Herdr terminal";
}

function alive() {
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === "EPERM";
  }
}

/**
 * The wrapper's pid plus Freebuff's children. The log writer is
 * `~/.config/manicode/freebuff`, a child of the TUI, so the root pid alone
 * never appears in the log. Cached because `ps` is a process spawn.
 */
function currentPids() {
  const now = Date.now();
  if (!pids.length || now - lastPidRefresh > 2000) {
    lastPidRefresh = now;
    pids = pidTree(pid);
  }
  return pids;
}

// Make the terminal an agent right away: the Agents panel should not wait for
// Freebuff to create a chat folder and write its first log line.
reporter.setTitle(project);
reporter.report("idle");

function adopt(next, byPid) {
  chat = next;
  matchedByPid = byPid;
  reader = createLogReader(chat.logPath);
  classifier = createClassifier();
  titleSettled = false;

  const title = readChatTitle(chat);
  if (title) {
    reporter.setTitle(title);
    titleSettled = true;
  } else {
    reporter.setTitle(fallbackTitle(chat));
  }

  for (const line of reader.read()) classifier.ingest(line);

  try {
    logWatcher?.close();
  } catch {
    // already closed
  }
  try {
    logWatcher = watch(chat.logPath, { persistent: false }, schedule);
    logWatcher.on("error", () => {
      logWatcher = null;
    });
  } catch (error) {
    debug(`watch failed: ${String(error)}`);
    logWatcher = null;
  }

  debug(`following ${chat.dir}`);
  report();
}

function report() {
  if (!classifier) return;
  const next = classifier.state();
  reporter.report(next.state, next.kind, next.msg);
}

function refreshTitle() {
  if (!chat || titleSettled) return;
  const title = readChatTitle(chat);
  if (!title) return;
  titleSettled = true;
  if (reporter.setTitle(title)) {
    debug(`title ${title}`);
    report();
  }
}

function findChat() {
  const direct = findChatByPid(root, currentPids(), { project });
  if (direct) return { chat: direct, byPid: true };
  // A resumed session can keep an old folder, and the very first message may
  // not be written yet, so give the pid match a few seconds before falling back.
  if (Date.now() - startedAt > FALLBACK_MS) {
    const fallback = newestChat(root, project);
    return fallback ? { chat: fallback, byPid: false } : null;
  }
  return null;
}

let timer = null;

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    tick();
  }, 25);
}

function tick() {
  const now = Date.now();

  if (!chat) {
    const found = findChat();
    if (found) adopt(found.chat, found.byPid);
  } else {
    const lines = reader.read();
    for (const line of lines) classifier.ingest(line);
    if (lines.length) report();
    refreshTitle();

    // If we had to fall back to "newest chat", switch to the right one as soon
    // as its pid shows up (a second pane in the same project).
    if (!matchedByPid && now - lastPidSearch > 5000) {
      lastPidSearch = now;
      const direct = findChatByPid(root, currentPids(), { project });
      if (direct && direct.dir !== chat.dir) adopt(direct, true);
    }
  }

  if (now - lastAliveCheck > 2000) {
    lastAliveCheck = now;
    if (!alive()) {
      debug("freebuff exited");
      reporter.clear();
      process.exit(0);
    }
  }
}

process.on("exit", () => reporter.clear());
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

tick();
setInterval(tick, 1000);
