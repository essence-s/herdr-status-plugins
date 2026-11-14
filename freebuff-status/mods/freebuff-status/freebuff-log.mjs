/**
 * Reading Freebuff's own chat files.
 *
 * Freebuff keeps one folder per conversation under
 * `~/.config/manicode/projects/<project>/chats/<timestamp>/`:
 *
 *   log.jsonl         append-only event log (one JSON object per line)
 *   chat-meta.json    small summary, including `firstPrompt`
 *   chat-messages.json / run-state.json   not read here
 *
 * The log is the only source that tells a turn apart from a sub-agent step:
 * `Start agent ... step N` / `End agent ... step N` happen many times per turn,
 * while `[send-message] ...` opens a turn and `Main prompt finished` closes it.
 * Reading them as turn boundaries (a common mistake) makes the status flicker.
 *
 * Nothing here reads the whole log again: `createLogReader` keeps a byte offset
 * and only decodes complete lines, so the cost stays flat as the log grows.
 */

import { execFileSync } from "node:child_process";
import { closeSync, fstatSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const DEFAULT_ROOT = join(homedir(), ".config", "manicode", "projects");

/** Every chat folder with a log, newest first. */
export function listChats(root = DEFAULT_ROOT) {
  const chats = [];
  let projects;
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return chats;
  }

  for (const project of projects) {
    const chatsDir = join(root, project.name, "chats");
    let entries;
    try {
      entries = readdirSync(chatsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(chatsDir, entry.name);
      const logPath = join(dir, "log.jsonl");
      let st;
      try {
        st = statSync(logPath);
      } catch {
        continue;
      }
      chats.push({
        dir,
        project: project.name,
        logPath,
        metaPath: join(dir, "chat-meta.json"),
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    }
  }

  return chats.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Last `maxBytes` of a file, or "" when it cannot be read. */
export function readTail(path, maxBytes = 16384) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, size - length + read);
      if (n <= 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

/**
 * One `ps` snapshot: `{ pid, ppid }` for every process it can see.
 *
 * Linux and macOS both understand `ps -eo pid=,ppid=`, which is why the pid
 * tree does not need `/proc`. An empty list is not an error: it only means the
 * tree cannot be resolved, and callers then fall back to the root pid alone.
 */
function defaultPs() {
  let out;
  try {
    out = execFileSync("ps", ["-eo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return [];
  }
  const rows = [];
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) rows.push({ pid, ppid });
  }
  return rows;
}

/**
 * `rootPid` plus every descendant.
 *
 * Freebuff's TUI does not write the log itself: it spawns
 * `~/.config/manicode/freebuff`, and that child is the process whose pid is on
 * every log line. Matching only the wrapper's pid (which `exec` hands to the
 * TUI) never matches, so the pid search would always fall back to "newest
 * chat". The watcher is a child of the TUI too, hence `exclude`.
 */
export function pidTree(rootPid, { ps = defaultPs, exclude = [process.pid] } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 1) return [];

  const children = new Map();
  for (const { pid, ppid } of ps()) {
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }

  const skip = new Set(exclude);
  const found = [];
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length) {
    const next = queue.shift();
    if (seen.has(next)) continue;
    seen.add(next);
    if (!skip.has(next)) found.push(next);
    for (const child of children.get(next) ?? []) queue.push(child);
  }
  return found;
}

/**
 * The chat whose log was written by `pidOrPids`. Freebuff writes the process
 * id on every line; pass the pid tree (see `pidTree`) because the writer is a
 * child of the TUI. This is exact even with several Freebuff panes open.
 *
 * `project` (the cwd's basename) narrows the search first: two panes in
 * different repositories never share a project folder, so the pid tail scan
 * only has to look at a handful of chats.
 */
export function findChatByPid(root = DEFAULT_ROOT, pidOrPids, { project, maxChats = 60, tailBytes = 65536 } = {}) {
  const pids = (Array.isArray(pidOrPids) ? pidOrPids : [pidOrPids]).filter(
    (pid) => Number.isInteger(pid) && pid > 1,
  );
  if (!pids.length) return null;

  const chats = listChats(root);
  const local = project ? chats.filter((chat) => chat.project === project) : [];
  const candidates = local.length ? local : chats;
  for (const chat of candidates.slice(0, maxChats)) {
    const tail = readTail(chat.logPath, tailBytes);
    if (pids.some((pid) => tail.includes(`"pid":${pid}`))) return chat;
  }
  return null;
}

/** Fallback when the pid never shows up (older logs, resumed sessions). */
export function newestChat(root = DEFAULT_ROOT, project) {
  const chats = listChats(root);
  if (project) {
    const local = chats.filter((chat) => chat.project === project);
    if (local.length) return local[0];
  }
  return chats[0] ?? null;
}

/**
 * The conversation title from `chat-meta.json`, or "" until the first message
 * is sent. Callers fall back to the project folder, but keep retrying: the meta
 * file appears a moment after the chat folder does.
 */
export function readChatTitle(chat) {
  if (!chat) return "";
  try {
    const meta = JSON.parse(readFileSync(chat.metaPath, "utf8"));
    if (typeof meta?.firstPrompt === "string" && meta.firstPrompt.trim()) {
      return meta.firstPrompt;
    }
  } catch {
    // no meta yet: the first message has not been sent
  }
  return "";
}

/** Title used when the meta file is not there yet. */
export function fallbackTitle(chat) {
  return basename(chat?.project || "");
}

/**
 * Incremental line reader. It survives the log being appended to, truncated or
 * replaced (a new session can reuse the folder), and it never splits a UTF-8
 * code point because it only decodes complete lines.
 */
export function createLogReader(logPath) {
  let offset = 0;
  let inode = null;
  let carry = Buffer.alloc(0);

  return {
    reset() {
      offset = 0;
      inode = null;
      carry = Buffer.alloc(0);
    },
    /** Complete new lines since the last call. */
    read() {
      let fd;
      try {
        fd = openSync(logPath, "r");
      } catch {
        return [];
      }
      try {
        const st = fstatSync(fd);
        if (inode !== null && (st.ino !== inode || st.size < offset)) {
          offset = 0;
          carry = Buffer.alloc(0);
        }
        inode = st.ino;
        if (st.size <= offset) return [];

        const length = st.size - offset;
        const buffer = Buffer.allocUnsafe(length);
        let read = 0;
        while (read < length) {
          const n = readSync(fd, buffer, read, length - read, offset + read);
          if (n <= 0) break;
          read += n;
        }
        offset += read;

        const chunk = carry.length ? Buffer.concat([carry, buffer.subarray(0, read)]) : buffer.subarray(0, read);
        const lines = [];
        let start = 0;
        for (let at = chunk.indexOf(0x0a); at !== -1; at = chunk.indexOf(0x0a, start)) {
          lines.push(chunk.subarray(start, at).toString("utf8"));
          start = at + 1;
        }
        carry = chunk.subarray(start);
        return lines;
      } catch {
        return [];
      } finally {
        closeSync(fd);
      }
    },
  };
}

const TIMESTAMP = /"timestamp":"([^"]+)"/;

const START = /^\[send-message\] Sending message/;
const QUEUED = /^\[message-queue\] Processing next message/;
const FINISH = /^Main prompt finished$/;
const ABORT = /^Agent run cancelled by user/;
const RETRY = /^(?:Network error, retrying|Health check failed, backing off)/;
const AUTH = /No authentication token found|Please run the login flow/;
const ERROR = /^(?:Error in AI SDK stream|startAgentRun error|finishAgentRun error)/;

function timestampOf(line) {
  const match = TIMESTAMP.exec(line);
  if (!match) return 0;
  const value = Date.parse(match[1]);
  return Number.isFinite(value) ? value : 0;
}

function messageOf(line) {
  // Freebuff writes the top-level `msg` as the last key of the object, after
  // `data`. Searching from the end avoids matching a `"msg"` inside a tool
  // result, and avoids a regex over a line that can be hundreds of kilobytes.
  const at = line.lastIndexOf('"msg":"');
  if (at < 0) return "";
  const start = at + '"msg":"'.length;
  let end = start;
  while (end < line.length) {
    const code = line.charCodeAt(end);
    if (code === 0x5c) {
      end += 2;
      continue;
    }
    if (code === 0x22) break;
    end++;
  }
  const raw = line.slice(start, end);
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/**
 * Turns log lines into one Herdr state. `ingest` is incremental; `state` is
 * cheap and idempotent, so it can be called on every tick.
 */
export function createClassifier() {
  let startTs = 0;
  let finishTs = 0;
  let event = null;
  const asked = new Map();

  function setEvent(ts, state, kind, msg) {
    if (!event || ts >= event.ts) event = { ts, state, kind, msg };
  }

  function ingestAskUser(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const data = parsed?.data;
    if (!data) return;
    const ts = timestampOf(line);

    for (const call of data.toolCalls ?? []) {
      if (call?.toolName !== "ask_user" || !call.toolCallId) continue;
      const question = call.input?.questions?.[0]?.question ?? call.input?.question ?? "";
      asked.set(call.toolCallId, { ts, question });
    }
    for (const result of data.toolResults ?? []) {
      if (result?.toolName !== "ask_user" || !result.toolCallId) continue;
      asked.delete(result.toolCallId);
    }
  }

  return {
    ingest(line) {
      if (!line) return;
      const ts = timestampOf(line);
      const msg = messageOf(line);

      if (line.includes('"toolName":"ask_user"') && (line.includes('"toolCalls"') || line.includes('"toolResults"'))) {
        ingestAskUser(line);
      }

      if (START.test(msg) || QUEUED.test(msg)) {
        startTs = ts;
        setEvent(ts, "working");
        return;
      }
      if (FINISH.test(msg)) {
        finishTs = ts;
        setEvent(ts, "done");
        return;
      }
      if (ABORT.test(msg)) {
        finishTs = ts;
        setEvent(ts, "done", undefined, "cancelled");
        return;
      }
      if (AUTH.test(msg)) {
        setEvent(ts, "blocked", "auth", msg);
        return;
      }
      if (ERROR.test(msg)) {
        setEvent(ts, "error", undefined, msg);
        return;
      }
      if (RETRY.test(msg) && startTs > finishTs) {
        setEvent(ts, "working", undefined, msg);
      }
    },

    /** The state to report right now. */
    state() {
      let pending = null;
      for (const [id, ask] of asked) {
        if (!pending || ask.ts >= pending.ts) pending = { id, ...ask };
      }
      if (pending && (!event || pending.ts >= event.ts)) {
        return {
          state: "blocked",
          kind: "question",
          msg: pending.question || "Freebuff is waiting for an answer",
        };
      }
      if (!event) return { state: "idle" };
      const result = { state: event.state };
      if (event.kind) result.kind = event.kind;
      if (event.msg) result.msg = event.msg;
      return result;
    },
  };
}
