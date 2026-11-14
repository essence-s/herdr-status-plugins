// herdr-kilo-status: Kilo Code terminals report their status to Herdr.
//
// Kilo is OpenCode-derived, so this is a server plugin. It writes OSC 7501
// (the Program Status Protocol) straight to the terminal, which is the only
// thing herdr-core reads to mark a terminal as an agent and give it a status
// (working / blocked / idle / done).
//
// herdr-core sets HC_TERMINAL_ID for every terminal it owns. Outside Herdr
// the plugin does nothing. Set KILO_HERDR_STATUS=0 to turn it off inside
// Herdr too. Delete the installed copy to uninstall.

import { closeSync, constants, openSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

/** The 7501 `app`: the key of Herdr's `kilocode` program, for its name and icon. */
export const APP = "kilocode";
export const PLUGIN_ID = "herdr-kilo-status";

/** OSC 7501 limits: title 192 decoded bytes, msg 2048. */
const MAX_TITLE_BYTES = 192;
const MAX_MSG_BYTES = 2048;
const MAX_APP_BYTES = 32;

export type Env = Record<string, string | undefined>;
export type Writer = (text: string) => void;
export type Debug = (message: string) => void;

/** `KILO_HERDR_STATUS=0|false|off|no|disabled` turns the bridge off. */
export function statusDisabled(env: Env = process.env): boolean {
  const value = (env.KILO_HERDR_STATUS ?? "").trim().toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "no" || value === "disabled";
}

/** Trims a UTF-8 string to a byte limit without cutting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  // 0b10xxxxxx is a continuation byte: back up to the start of its code point.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8").replace(/\s+$/u, "");
}

/**
 * A single-line, control-character-free value capped at `maxBytes`. OSC 7501
 * carries msg/title as base64, but newlines and tabs are still forbidden, and
 * a long value would be dropped by the terminal.
 */
export function cleanText(value: unknown, maxBytes: number): string {
  if (typeof value !== "string") return "";
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf8(text, maxBytes);
}

/** `app` is `[A-Za-z0-9_.+-]{1,32}`; anything else becomes a dash. */
export function cleanApp(value: unknown): string {
  const app = String(value ?? APP)
    .replace(/[^A-Za-z0-9_.+-]/g, "-")
    .slice(0, MAX_APP_BYTES);
  return app || APP;
}

export function encodeBase64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * `ESC ] 7501 ; state=<s>:app=kilocode[:kind=...][:title=<b64>][:msg=<b64>] ESC \`
 * A report replaces the record, so `app` and `title` go on every report.
 */
export function osc(input: {
  state: string;
  kind?: string;
  app?: string;
  title?: string;
  msg?: string;
}): string {
  const fields = [`state=${input.state}`, `app=${cleanApp(input.app)}`];
  if (input.kind) fields.push(`kind=${input.kind}`);

  const title = cleanText(input.title, MAX_TITLE_BYTES);
  if (title) fields.push(`title=${encodeBase64(title)}`);

  const msg = cleanText(input.msg, MAX_MSG_BYTES);
  if (msg) fields.push(`msg=${encodeBase64(msg)}`);

  return `\x1b]7501;${fields.join(":")}\x1b\\`;
}

/** Ttys of our ancestors, for when the plugin runs without a controlling terminal. */
export function ancestorTtys(): string[] {
  const ttys: string[] = [];
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let out: string;
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

function openTty(env: Env, debug: Debug): number | null {
  if (process.platform === "win32") return null;

  const override = env.KILO_HERDR_STATUS_TTY;
  const candidates = override ? [override] : ["/dev/tty"];

  if (!override) {
    // Only real ttys: opening /dev/fd/1 on a pipe would write into the pipe.
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

function makeWriter(env: Env, debug: Debug): Writer {
  let fd: number | null | undefined;

  return (text: string) => {
    if (fd === undefined) fd = openTty(env, debug);
    if (fd === null) return;

    try {
      writeSync(fd, text);
    } catch (error) {
      debug(`write failed: ${String(error)}`);
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
      fd = undefined; // try to find a terminal again next time
    }
  };
}

export type Bridge = {
  readonly enabled: boolean;
  readonly state: string | null;
  readonly title: string;
  report(state: string, kind?: string, msg?: string): void;
  setTitle(value: string): boolean;
};

/**
 * Dedupes reports and remembers the title. `write` is injectable so the tests
 * never need a real terminal.
 */
export function createBridge(options: { env?: Env; write?: Writer; debug?: Debug } = {}): Bridge {
  const env = options.env ?? process.env;
  const debug = options.debug ?? (() => {});
  const write = options.write ?? makeWriter(env, debug);
  const enabled = !statusDisabled(env) && Boolean(env.HC_TERMINAL_ID);

  let lastText: string | null = null;
  let lastState: string | null = null;
  let title = "";

  function report(state: string, kind?: string, msg?: string) {
    if (!enabled) return;
    const text = osc({ state, kind, msg, title });
    if (text === lastText) return;
    lastText = text;
    lastState = state;
    write(text);
    debug(`reported ${state}${kind ? `:${kind}` : ""}`);
  }

  function setTitle(value: string): boolean {
    const next = cleanText(value, MAX_TITLE_BYTES);
    if (next === title) return false;
    title = next;
    return true;
  }

  return {
    enabled,
    get state() {
      return lastState;
    },
    get title() {
      return title;
    },
    report,
    setTitle,
  };
}

function statusWord(status: unknown): "idle" | "working" | undefined {
  const raw =
    typeof status === "string"
      ? status
      : typeof status === "object" && status !== null && "type" in status
        ? (status as { type?: unknown }).type
        : undefined;

  if (typeof raw !== "string") return undefined;

  switch (raw.toLowerCase()) {
    case "idle":
      return "idle";
    case "active":
    case "busy":
    case "pending":
    case "retry":
    case "running":
    case "streaming":
    case "working":
      return "working";
    default:
      return undefined;
  }
}

function errorReport(error: unknown): { state: string; kind?: string; msg?: string } {
  const record = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    data?: { message?: unknown };
  };
  const name = typeof record.name === "string" ? record.name : "";
  const message = typeof record.data?.message === "string" ? record.data.message : "";

  if (name === "MessageAbortedError") return { state: "idle" };
  if (name === "ProviderAuthError") {
    return { state: "blocked", kind: "auth", msg: message || "Sign in to the provider" };
  }
  return { state: "error", msg: message || name || "Kilo error" };
}

function permissionMessage(properties: Record<string, unknown>): string {
  const permission = typeof properties.permission === "string" ? properties.permission : "";
  const action = typeof properties.action === "string" ? properties.action : "";
  const list = Array.isArray(properties.patterns)
    ? properties.patterns
    : Array.isArray(properties.resources)
      ? properties.resources
      : [];
  const detail = list.filter((item): item is string => typeof item === "string").join(", ");
  return [permission || action, detail].filter(Boolean).join(": ") || "Waiting for your permission";
}

function questionMessage(properties: Record<string, unknown>): string {
  const questions = Array.isArray(properties.questions) ? properties.questions : [];
  for (const item of questions) {
    if (typeof item === "object" && item !== null && "question" in item) {
      const question = (item as { question?: unknown }).question;
      if (typeof question === "string" && question.trim()) return question;
    }
  }
  return "Waiting for your answer";
}

export type Hooks = {
  dispose?: () => Promise<void>;
  event?: (input: { event?: { type?: string; properties?: Record<string, unknown> } }) => Promise<void>;
  "chat.message"?: (input: { sessionID?: string }) => Promise<void>;
  "command.execute.before"?: (input: { sessionID?: string }) => Promise<void>;
  "tool.execute.before"?: (input: { sessionID?: string }) => Promise<void>;
  "tool.execute.after"?: (input: { sessionID?: string }) => Promise<void>;
};

/** Kilo's placeholder until it has a real title. */
const DEFAULT_TITLE = /^(new session|new chat|untitled)\b/iu;

/**
 * Maps Kilo events to OSC 7501. Sub-agent sessions are tracked so their late
 * `idle` cannot finish the parent's turn.
 */
export function createHooks(bridge: Bridge): Hooks {
  const children = new Set<string>();
  let active: string | null = null;

  function noteSession(info: unknown) {
    if (typeof info !== "object" || info === null) return;
    const session = info as { id?: unknown; parentID?: unknown; title?: unknown };
    if (typeof session.id !== "string" || !session.id) return;

    if (typeof session.parentID === "string" && session.parentID) {
      children.add(session.id);
      return;
    }
    if (children.has(session.id)) return;

    if (active === null || active === session.id) {
      active = session.id;
      if (
        typeof session.title === "string" &&
        !DEFAULT_TITLE.test(session.title) &&
        bridge.setTitle(session.title)
      ) {
        // A report replaces the record, so resend the current state with the new title.
        if (bridge.state) bridge.report(bridge.state);
      }
    }
  }

  function isChild(sessionID: unknown): boolean {
    return typeof sessionID === "string" && children.has(sessionID);
  }

  return {
    dispose: async () => {
      bridge.report("clear");
    },

    "chat.message": async (input) => {
      if (typeof input?.sessionID === "string" && !isChild(input.sessionID)) active = input.sessionID;
      bridge.report("working");
    },

    "command.execute.before": async () => {
      bridge.report("working");
    },

    "tool.execute.before": async () => {
      bridge.report("working");
    },

    "tool.execute.after": async () => {
      bridge.report("working");
    },

    event: async ({ event }) => {
      const type = event?.type;
      const properties = event?.properties ?? {};
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
      const info = properties.info;

      if (info) noteSession(info);

      switch (type) {
        case "session.status": {
          const status = properties.status;
          if (typeof status === "object" && status !== null && (status as { type?: unknown }).type === "retry") {
            const retry = status as { attempt?: unknown; message?: unknown };
            const attempt = typeof retry.attempt === "number" ? ` (${retry.attempt})` : "";
            const message = typeof retry.message === "string" ? `: ${retry.message}` : "";
            bridge.report("working", undefined, `Retrying${attempt}${message}`);
            return;
          }

          const state = statusWord(status);
          if (!state) return;
          // A late idle must not erase the done/error that says a turn ended
          // while the person was not looking. A new turn reports working.
          if (state === "idle" && (bridge.state === "done" || bridge.state === "error")) return;
          if (state === "idle" && isChild(sessionID)) return;
          bridge.report(state);
          return;
        }

        case "session.idle": {
          if (isChild(sessionID)) return;
          bridge.report("done");
          return;
        }

        case "session.error": {
          const report = errorReport(properties.error);
          bridge.report(report.state, report.kind, report.msg);
          return;
        }

        case "permission.asked":
        case "permission.v2.asked": {
          bridge.report("blocked", "permission", permissionMessage(properties));
          return;
        }

        case "question.asked":
        case "question.v2.asked": {
          bridge.report("blocked", "question", questionMessage(properties));
          return;
        }

        case "permission.replied":
        case "permission.v2.replied":
        case "question.replied":
        case "question.rejected":
        case "session.compacted": {
          bridge.report("working");
          return;
        }

        case "session.deleted": {
          const deleted =
            typeof info === "object" && info !== null && typeof (info as { id?: unknown }).id === "string"
              ? ((info as { id: string }).id)
              : sessionID;
          if (deleted) children.delete(deleted);
          // Deleting a sub-agent or another session must not clear the one on screen.
          if (deleted && deleted !== active) return;
          active = null;
          bridge.setTitle("");
          bridge.report("clear");
          return;
        }

        case "session.created":
        case "session.updated":
        default:
          return;
      }
    },
  };
}

export type PluginInput = {
  directory?: string;
  worktree?: string;
};

/**
 * Builds the Kilo server plugin. `options` exists for the tests; Kilo calls the
 * returned function with its own PluginInput.
 */
export function makeServer(options: { env?: Env; write?: Writer; debug?: Debug } = {}) {
  return async (input?: PluginInput): Promise<Hooks> => {
    const env = options.env ?? process.env;
    const debug = options.debug ?? (() => {});
    const bridge = createBridge({ env, write: options.write, debug });

    if (!bridge.enabled) return {};

    const folder = input?.worktree || input?.directory;
    if (typeof folder === "string" && folder) bridge.setTitle(basename(folder));

    // Kilo is up: make the terminal an agent before the first turn.
    bridge.report("idle");

    // A program that exits should leave a clean record, not a stale agent.
    const clearOnExit = () => bridge.report("clear");
    process.on("exit", clearOnExit);

    const hooks = createHooks(bridge);
    const dispose = hooks.dispose;
    hooks.dispose = async () => {
      process.off("exit", clearOnExit);
      if (dispose) await dispose();
    };
    return hooks;
  };
}

const debug: Debug = (message) => {
  if (process.env.KILO_HERDR_DEBUG !== "1") return;
  try {
    writeSync(2, `[${PLUGIN_ID}] ${message}\n`);
  } catch {
    // nothing to do
  }
};

export default { id: PLUGIN_ID, server: makeServer({ debug }) };
