import assert from "node:assert/strict";
import { test } from "node:test";

import {
  APP,
  cleanApp,
  cleanText,
  createReporter,
  encodeBase64,
  osc,
  statusDisabled,
  truncateUtf8,
} from "../mods/freebuff-status/herdr-report.mjs";

/** Splits an OSC 7501 sequence into its fields, decoding the base64 ones. */
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
  const reporter = createReporter({
    env: { HC_TERMINAL_ID: "t-test", ...env },
    write: (text) => {
      out.push(text);
      return true;
    },
  });
  return { out, reporter };
}

test("osc writes state, app, kind, title and msg", () => {
  const fields = parse(osc({ state: "blocked", kind: "question", title: "Fix login", msg: "Which database?" }));
  assert.deepEqual(fields, {
    state: "blocked",
    app: APP,
    kind: "question",
    title: "Fix login",
    msg: "Which database?",
  });
});

test("osc omits empty text and keeps app on every report", () => {
  assert.deepEqual(parse(osc({ state: "idle" })), { state: "idle", app: APP });
});

test("control characters are replaced and whitespace collapsed", () => {
  assert.equal(cleanText("a\nb\tc\u0000d\u001b[31m", 100), "a b c d [31m");
});

test("title and msg are capped without cutting a UTF-8 code point", () => {
  const title = truncateUtf8("á".repeat(200), 192);
  assert.ok(Buffer.byteLength(title) <= 192);
  assert.equal(title, "á".repeat(96));
  assert.equal(truncateUtf8("ok", 192), "ok");
});

test("app is restricted to the protocol alphabet", () => {
  assert.equal(cleanApp("free buff/1"), "free-buff-1");
  assert.equal(cleanApp(""), APP);
});

test("statusDisabled accepts the documented off values", () => {
  for (const value of ["0", "false", "off", "no", "disabled", " OFF "]) {
    assert.equal(statusDisabled({ FREEBUFF_HERDR_STATUS: value }), true, value);
  }
  for (const value of ["", "1", "yes", "on"]) {
    assert.equal(statusDisabled({ FREEBUFF_HERDR_STATUS: value }), false, value);
  }
});

test("reports are ignored outside Herdr", () => {
  const out = [];
  const reporter = createReporter({ env: {}, write: (text) => out.push(text) });
  assert.equal(reporter.enabled, false);
  assert.equal(reporter.report("working"), false);
  assert.deepEqual(out, []);
});

test("reports are ignored when disabled", () => {
  const out = [];
  const reporter = createReporter({
    env: { HC_TERMINAL_ID: "t-test", FREEBUFF_HERDR_STATUS: "0" },
    write: (text) => out.push(text),
  });
  assert.equal(reporter.enabled, false);
  assert.equal(reporter.report("working"), false);
  assert.deepEqual(out, []);
});

test("the same report is sent once", () => {
  const { out, reporter } = setup();
  assert.equal(reporter.report("working"), true);
  assert.equal(reporter.report("working"), false);
  assert.equal(out.length, 1);
  assert.equal(parse(out[0]).state, "working");
});

test("a title change re-emits the same state with the title", () => {
  const { out, reporter } = setup();
  reporter.setTitle("first");
  reporter.report("working");
  reporter.setTitle("second");
  reporter.report("working");
  assert.equal(out.length, 2);
  assert.equal(parse(out[1]).title, "second");
  assert.equal(parse(out[1]).state, "working");
});

test("clear is idempotent and carries the title", () => {
  const { out, reporter } = setup();
  reporter.setTitle("demo");
  reporter.report("done");
  reporter.clear();
  reporter.clear();
  assert.equal(out.length, 2);
  assert.equal(parse(out[1]).state, "clear");
  assert.equal(parse(out[1]).title, "demo");
});

test("base64 round-trips UTF-8", () => {
  assert.equal(Buffer.from(encodeBase64("ñandú"), "base64").toString("utf8"), "ñandú");
});
