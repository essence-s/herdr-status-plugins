/**
 * OSC 7501 reporting for Herdr.
 *
 * The protocol is one escape sequence per report:
 *
 *   ESC ] 7501 ; state=<state>:app=<app>[:kind=<kind>][:title=<b64>][:msg=<b64>] ESC \
 *
 * Herdr replaces the whole record on every report, so `app` and `title` must be
 * sent every time. `title` and `msg` are base64 because they carry arbitrary
 * UTF-8; both are single-line, control-character-free and capped at 192 and
 * 2048 decoded bytes.
 *
 * Nothing here talks to Herdr: the report goes to the terminal, and Herdr reads
 * it from the pty. That is why this works from a background process too.
 */

import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";

export const APP = "freebuff";
export const PLUGIN_ID = "freebuff-status";
export const MAX_TITLE_BYTES = 192;
export const MAX_MSG_BYTES = 2048;
export const MAX_APP_BYTES = 32;

/** Cuts a string at a UTF-8 byte boundary, never through a code point. */
export function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8").replace(/\s+$/u, "");
}

/** One line, no control characters, no runs of whitespace, capped in bytes. */
export function cleanText(value, maxBytes) {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf8(text, maxBytes);
}

/** The protocol allows a small set of characters in `app`. */
export function cleanApp(value) {
  const app = String(value ?? APP)
    .replace(/[^A-Za-z0-9_.+-]/g, "-")
    .slice(0, MAX_APP_BYTES);
  return app || APP;
}

export function encodeBase64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Builds one OSC 7501 report. Exported so tests can assert the exact bytes. */
export function osc({ state, kind, msg, title, app = APP }) {
  const fields = [`state=${state}`, `app=${cleanApp(app)}`];
  if (kind) fields.push(`kind=${kind}`);
  const safeTitle = cleanText(title, MAX_TITLE_BYTES);
  if (safeTitle) fields.push(`title=${encodeBase64(safeTitle)}`);
  const safeMsg = cleanText(msg, MAX_MSG_BYTES);
  if (safeMsg) fields.push(`msg=${encodeBase64(safeMsg)}`);
  return `\x1b]7501;${fields.join(":")}\x1b\\`;
}

const OFF_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

/** `FREEBUFF_HERDR_STATUS=0` keeps the wrapper but silences the reports. */
export function statusDisabled(env = process.env) {
  const value = (env.FREEBUFF_HERDR_STATUS ?? "").trim().toLowerCase();
  return OFF_VALUES.has(value);
}

function ancestorTtys() {
  const ttys = [];
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let out;
    try {
      out = execFileSync("ps", ["-o", "tty=,ppid=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 500,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      break;
    }
    const [tty, ppid] = out.split(/\s+/u);
    if (tty && /\d/u.test(tty) && !tty.includes("?")) {
      ttys.push(tty.startsWith("/dev/") ? tty : `/dev/${tty}`);
    }
    pid = Number(ppid);
  }
  return [...new Set(ttys)];
}

/**
 * Opens the terminal the reports go to. `/dev/tty` is the controlling terminal
 * of this process, which is the Freebuff pty even when the watcher runs in the
 * background. The rest are fallbacks for setups without a controlling tty.
 */
export function openTty(env = process.env, debug = () => {}) {
  const override = env.FREEBUFF_HERDR_STATUS_TTY;
  const candidates = override ? [override] : ["/dev/tty"];

  if (!override) {
    if (process.stdout.isTTY) candidates.push("/dev/fd/1");
    if (process.stderr.isTTY) candidates.push("/dev/fd/2");
    if (process.stdin.isTTY) candidates.push("/dev/fd/0");
    candidates.push(...ancestorTtys());
  }

  const flags = constants.O_WRONLY | (constants.O_NOCTTY ?? 0);
  for (const path of candidates) {
    try {
      return openSync(path, flags);
    } catch (error) {
      debug(`${path} unavailable: ${String(error)}`);
    }
  }
  return null;
}

/** A synchronous writer: the report must not wait for the event loop. */
export function makeWriter(env = process.env, debug = () => {}) {
  let fd;
  return (text) => {
    if (fd === undefined) fd = openTty(env, debug);
    if (fd === null) return false;
    try {
      writeSync(fd, text);
      return true;
    } catch (error) {
      debug(`write failed: ${String(error)}`);
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      fd = undefined;
      return false;
    }
  };
}

/**
 * Stateful reporter with dedupe. It keeps the last title so a title change
 * re-emits the same state with the new title (Herdr replaces the record).
 */
export function createReporter({ env = process.env, write, debug = () => {} } = {}) {
  const writer = write ?? makeWriter(env, debug);
  const enabled = !statusDisabled(env) && Boolean(env.HC_TERMINAL_ID);
  let title = "";
  let last = null;

  /** Returns true when the title actually changed. */
  function setTitle(value) {
    const next = cleanText(value, MAX_TITLE_BYTES);
    if (next === title) return false;
    title = next;
    return true;
  }

  /** Returns true when a sequence was written. */
  function report(state, kind, msg) {
    if (!enabled) return false;
    const text = osc({ state, kind, msg, title });
    if (text === last) return false;
    last = text;
    const ok = writer(text);
    debug(`reported ${state}${kind ? `:${kind}` : ""}${ok ? "" : " (no tty)"}`);
    return ok;
  }

  return {
    enabled,
    get title() {
      return title;
    },
    setTitle,
    report,
    /** Removes the agent from Herdr's list. Safe to call more than once. */
    clear() {
      return report("clear");
    },
  };
}
