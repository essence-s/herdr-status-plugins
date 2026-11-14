import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP,
  cleanApp,
  cleanText,
  createBridge,
  createHooks,
  encodeBase64,
  osc,
  statusDisabled,
  truncateUtf8,
} from "../mods/kilo-status/herdr-agent-state.ts";

/** Splits an OSC 7501 sequence into its key/value pairs, decoding base64 text. */
function parse(text) {
  assert.match(text, /^\x1b\]7501;.*\x1b\\$/s);
  const body = text.slice("\x1b]7501;".length, -"\x1b\\".length);
  const fields = {};
  for (const part of body.split(":")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at);
    const value = part.slice(at + 1);
    fields[key] = key === "title" || key === "msg" ? Buffer.from(value, "base64").toString("utf8") : value;
  }
  return fields;
}

function setup(env = {}) {
  const out = [];
  const bridge = createBridge({
    env: { HC_TERMINAL_ID: "t-test", ...env },
    write: (text) => out.push(text),
  });
  return { out, bridge, hooks: createHooks(bridge) };
}

test("osc writes state, app, kind, title and msg", () => {
  const text = osc({ state: "blocked", kind: "permission", title: "Fix login", msg: "bash: rm -rf build" });
  const fields = parse(text);
  assert.equal(fields.state, "blocked");
  assert.equal(fields.app, APP);
  assert.equal(fields.kind, "permission");
  assert.equal(fields.title, "Fix login");
  assert.equal(fields.msg, "bash: rm -rf build");
  assert.equal(fields.title, "Fix login");
});

test("osc omits empty text and keeps app on every report", () => {
  const fields = parse(osc({ state: "idle" }));
  assert.deepEqual(fields, { state: "idle", app: APP });
});

test("control characters are replaced and whitespace collapsed", () => {
  assert.equal(cleanText("a\nb\tc\u0000d\u001b[31m", 100), "a b c d [31m");
});

test("title and msg are capped without cutting a UTF-8 code point", () => {
  const text = "é".repeat(200); // 2 bytes each
  const cut = truncateUtf8(text, 11);
  assert.equal(Buffer.byteLength(cut), 10);
  assert.equal(cut, "é".repeat(5));

  const fields = parse(osc({ state: "working", title: text, msg: "é".repeat(2000) }));
  assert.equal(Buffer.byteLength(fields.title), 192);
  assert.equal(Buffer.byteLength(fields.msg), 2048);
});

test("app is forced into [A-Za-z0-9_.+-]{1,32}", () => {
  assert.equal(cleanApp("kilo code!"), "kilo-code-");
  assert.equal(cleanApp("x".repeat(50)).length, 32);
  assert.equal(cleanApp(""), APP);
});

test("KILO_HERDR_STATUS turns the bridge off", () => {
  for (const value of ["0", "false", "off", "no", "disabled", " OFF "]) {
    assert.equal(statusDisabled({ KILO_HERDR_STATUS: value }), true, value);
  }
  for (const value of ["1", "true", "on", "", undefined]) {
    assert.equal(statusDisabled({ KILO_HERDR_STATUS: value }), false, String(value));
  }
});

test("bridge dedupes reports and resends when the title changes", () => {
  const { out, bridge } = setup();
  bridge.report("idle");
  bridge.report("idle");
  assert.equal(out.length, 1);

  bridge.setTitle("Fix login");
  bridge.report("idle");
  assert.equal(out.length, 2);
  assert.equal(parse(out[1]).title, "Fix login");

  bridge.report("working");
  bridge.report("working");
  assert.equal(out.length, 3);
});

test("bridge does nothing without HC_TERMINAL_ID", () => {
  const out = [];
  const bridge = createBridge({ env: { KILO_HERDR_STATUS: "1" }, write: (text) => out.push(text) });
  bridge.report("working");
  assert.equal(out.length, 0);
  assert.equal(bridge.enabled, false);
});

test("a permission request is blocked with the permission and its patterns", async () => {
  const { out, hooks } = setup();
  await hooks.event({
    event: {
      type: "permission.asked",
      properties: { sessionID: "s1", permission: "bash", patterns: ["rm -rf build", "ls"] },
    },
  });
  const fields = parse(out.at(-1));
  assert.equal(fields.state, "blocked");
  assert.equal(fields.kind, "permission");
  assert.equal(fields.msg, "bash: rm -rf build, ls");
});

test("a question is blocked with the question text", async () => {
  const { out, hooks } = setup();
  await hooks.event({
    event: {
      type: "question.asked",
      properties: { sessionID: "s1", questions: [{ question: "Which database?" }] },
    },
  });
  const fields = parse(out.at(-1));
  assert.equal(fields.state, "blocked");
  assert.equal(fields.kind, "question");
  assert.equal(fields.msg, "Which database?");
});

test("a turn goes working, done, and a late idle does not erase done", async () => {
  const { out, hooks } = setup();
  await hooks["chat.message"]({ sessionID: "s1" });
  assert.equal(parse(out.at(-1)).state, "working");

  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
  assert.equal(parse(out.at(-1)).state, "done");

  const before = out.length;
  await hooks.event({ event: { type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } } });
  assert.equal(out.length, before);
});

test("the session title is sent with every later report", async () => {
  const { out, hooks } = setup();
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "s1", title: "Fix login" } } },
  });
  await hooks["chat.message"]({ sessionID: "s1" });
  assert.equal(parse(out.at(-1)).title, "Fix login");
});

test("a placeholder session title keeps the project folder name", async () => {
  const { out, bridge, hooks } = setup();
  bridge.setTitle("kilo-demo");
  bridge.report("idle");

  await hooks.event({
    event: {
      type: "session.created",
      properties: { info: { id: "s1", title: "New session - 2026-11-13T19:46:45.427Z" } },
    },
  });
  await hooks["chat.message"]({ sessionID: "s1" });
  assert.equal(parse(out.at(-1)).title, "kilo-demo");

  await hooks.event({
    event: { type: "session.updated", properties: { info: { id: "s1", title: "Fix login" } } },
  });
  assert.equal(parse(out.at(-1)).title, "Fix login");
});

test("a sub-agent's idle does not finish the parent turn", async () => {
  const { out, hooks } = setup();
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "s1", title: "Parent" } } },
  });
  await hooks["chat.message"]({ sessionID: "s1" });
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "c1", parentID: "s1" } } },
  });
  const before = out.length;
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "c1" } } });
  assert.equal(out.length, before);
});

test("an auth error is blocked with kind auth; an abort is idle", async () => {
  const { out, hooks } = setup();
  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: "s1", error: { name: "ProviderAuthError", data: { message: "Bad key" } } },
    },
  });
  let fields = parse(out.at(-1));
  assert.equal(fields.state, "blocked");
  assert.equal(fields.kind, "auth");
  assert.equal(fields.msg, "Bad key");

  await hooks.event({
    event: {
      type: "session.error",
      properties: { sessionID: "s1", error: { name: "MessageAbortedError", data: { message: "aborted" } } },
    },
  });
  fields = parse(out.at(-1));
  assert.equal(fields.state, "idle");
});

test("deleting a child session does not clear the parent", async () => {
  const { out, hooks } = setup();
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "s1", title: "Parent" } } },
  });
  await hooks.event({
    event: { type: "session.created", properties: { info: { id: "c1", parentID: "s1" } } },
  });
  await hooks["chat.message"]({ sessionID: "s1" });
  const before = out.length;
  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "c1", parentID: "s1" } } } });
  assert.equal(out.length, before);

  await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } });
  assert.equal(parse(out.at(-1)).state, "clear");
});

test("dispose clears the record", async () => {
  const { out, hooks } = setup();
  await hooks["chat.message"]({ sessionID: "s1" });
  await hooks.dispose();
  assert.equal(parse(out.at(-1)).state, "clear");
});

test("base64 is standard, padded base64", () => {
  assert.equal(encodeBase64("hello"), "aGVsbG8=");
});
