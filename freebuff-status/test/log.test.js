import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createClassifier,
  createLogReader,
  fallbackTitle,
  findChatByPid,
  listChats,
  newestChat,
  pidTree,
  readChatTitle,
} from "../mods/freebuff-status/freebuff-log.mjs";

const TS = "2026-11-13T10:00:00.000Z";

function line(msg, { ts = TS, pid = 4242, data } = {}) {
  return JSON.stringify({ level: "INFO", timestamp: ts, pid, hostname: "test", msg, ...(data ? { data } : {}) });
}

function askUserLine(id, question, { ts = TS, answered = false } = {}) {
  const data = answered
    ? { toolResults: [{ role: "tool", toolName: "ask_user", toolCallId: id, content: [] }] }
    : { toolCalls: [{ toolName: "ask_user", toolCallId: id, input: { questions: [{ question, header: "Q" }] } }] };
  return JSON.stringify({ level: "DEBUG", timestamp: ts, pid: 4242, msg: "step", data });
}

function stateAfter(...lines) {
  const classifier = createClassifier();
  for (const item of lines) classifier.ingest(item);
  return classifier.state();
}

test("a turn starts working and finishes done", () => {
  assert.deepEqual(stateAfter(line("[send-message] Sending message with sdk run config")), { state: "working" });
  assert.deepEqual(
    stateAfter(
      line("[send-message] Sending message with sdk run config"),
      line("Main prompt finished", { ts: "2026-11-13T10:01:00.000Z" }),
    ),
    { state: "done" },
  );
});

test("sub-agent steps do not finish the turn", () => {
  const state = stateAfter(
    line("[send-message] Sending message with sdk run config", { ts: "2026-11-13T10:00:00.000Z" }),
    line("Start agent base3-free-catalog step 1 (abc)", { ts: "2026-11-13T10:00:01.000Z" }),
    line("End agent base3-free-catalog step 1 (abc)", { ts: "2026-11-13T10:00:02.000Z" }),
    line("Start agent base3-free-catalog step 2 (def)", { ts: "2026-11-13T10:00:03.000Z" }),
    line("End agent base3-free-catalog step 2 (def)", { ts: "2026-11-13T10:00:04.000Z" }),
  );
  assert.equal(state.state, "working");
});

test("an abort finishes the turn with a reason", () => {
  assert.deepEqual(
    stateAfter(
      line("[send-message] Sending message with sdk run config"),
      line("Agent run cancelled by user (abort error)", { ts: "2026-11-13T10:02:00.000Z" }),
    ),
    { state: "done", msg: "cancelled" },
  );
});

test("a missing token blocks with kind=auth", () => {
  const state = stateAfter(line("No authentication token found. Please run the login flow or set CODEBUFF_API_KEY."));
  assert.equal(state.state, "blocked");
  assert.equal(state.kind, "auth");
  assert.match(state.msg, /authentication token/);
});

test("a stream error is reported as error", () => {
  const state = stateAfter(line("Error in AI SDK stream"));
  assert.equal(state.state, "error");
  assert.match(state.msg, /AI SDK/);
});

test("retries only count while a turn is active", () => {
  const idle = stateAfter(line("Network error, retrying in 4000ms", { ts: "2026-11-13T10:05:00.000Z" }));
  assert.equal(idle.state, "idle");

  const active = stateAfter(
    line("[send-message] Sending message with sdk run config", { ts: "2026-11-13T10:00:00.000Z" }),
    line("Network error, retrying in 4000ms", { ts: "2026-11-13T10:00:05.000Z" }),
  );
  assert.equal(active.state, "working");
  assert.match(active.msg, /retrying/);
});

test("an unanswered ask_user blocks with the question", () => {
  const state = stateAfter(
    line("[send-message] Sending message with sdk run config", { ts: "2026-11-13T10:00:00.000Z" }),
    askUserLine("call-1", "Which database?", { ts: "2026-11-13T10:00:10.000Z" }),
  );
  assert.deepEqual(state, { state: "blocked", kind: "question", msg: "Which database?" });
});

test("answering the question resumes working", () => {
  const state = stateAfter(
    line("[send-message] Sending message with sdk run config", { ts: "2026-11-13T10:00:00.000Z" }),
    askUserLine("call-1", "Which database?", { ts: "2026-11-13T10:00:10.000Z" }),
    askUserLine("call-1", "", { ts: "2026-11-13T10:00:20.000Z", answered: true }),
  );
  assert.equal(state.state, "working");
});

test("a finish after a question wins over the question", () => {
  const state = stateAfter(
    line("[send-message] Sending message with sdk run config", { ts: "2026-11-13T10:00:00.000Z" }),
    askUserLine("call-1", "Which database?", { ts: "2026-11-13T10:00:10.000Z" }),
    line("Main prompt finished", { ts: "2026-11-13T10:00:20.000Z" }),
  );
  assert.equal(state.state, "done");
});

test("an empty log is idle", () => {
  assert.deepEqual(stateAfter(), { state: "idle" });
});

test("the reader returns only new complete lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "freebuff-reader-"));
  const path = join(dir, "log.jsonl");
  try {
    writeFileSync(path, `${line("one")}\n${line("two")}\n`);
    const reader = createLogReader(path);
    assert.equal(reader.read().length, 2);
    assert.deepEqual(reader.read(), []);

    appendFileSync(path, line("three"));
    assert.deepEqual(reader.read(), []);

    appendFileSync(path, "\n");
    assert.equal(reader.read().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reader resets when the log is truncated", () => {
  const dir = mkdtempSync(join(tmpdir(), "freebuff-truncate-"));
  const path = join(dir, "log.jsonl");
  try {
    writeFileSync(path, `${line("one")}\n${line("two")}\n`);
    const reader = createLogReader(path);
    assert.equal(reader.read().length, 2);

    writeFileSync(path, `${line("again")}\n`);
    assert.equal(reader.read().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeChat(root, project, name, pid) {
  const dir = join(root, project, "chats", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "log.jsonl"), `${line("[send-message] Sending message with sdk run config", { pid })}\n`);
  writeFileSync(join(dir, "chat-meta.json"), JSON.stringify({ firstPrompt: `prompt of ${name}` }));
  return dir;
}

test("findChatByPid picks the chat written by that process", () => {
  const root = mkdtempSync(join(tmpdir(), "freebuff-chats-"));
  try {
    const first = makeChat(root, "alpha", "2026-11-13T10-00-00.000Z", 111);
    const second = makeChat(root, "beta", "2026-11-13T11-00-00.000Z", 222);

    assert.equal(findChatByPid(root, 111)?.dir, first);
    assert.equal(findChatByPid(root, 222)?.dir, second);
    assert.equal(findChatByPid(root, 999), null);
    assert.equal(findChatByPid(root, 0), null);
    assert.equal(listChats(root).length, 2);

    assert.equal(findChatByPid(root, 111, { project: "alpha" })?.dir, first);
    assert.equal(findChatByPid(root, 222, { project: "alpha" }), null);
    assert.equal(newestChat(root, "alpha")?.dir, first);
    assert.equal(newestChat(root, "beta")?.dir, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findChatByPid accepts the pid tree, so a child writer matches", () => {
  const root = mkdtempSync(join(tmpdir(), "freebuff-chats-"));
  try {
    // The wrapper's pid is 111; Freebuff's child writes the log as 222.
    const child = makeChat(root, "alpha", "2026-11-13T10-00-00.000Z", 222);
    makeChat(root, "alpha", "2026-11-13T09-00-00.000Z", 555);

    assert.equal(findChatByPid(root, 111), null);
    assert.equal(findChatByPid(root, [111, 222])?.dir, child);
    assert.equal(findChatByPid(root, [], { project: "alpha" }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pidTree returns the root and its descendants", () => {
  const rows = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 13, ppid: 1 },
    { pid: 99, ppid: 10 },
  ];
  const ps = () => rows;

  assert.deepEqual(pidTree(10, { ps, exclude: [] }), [10, 11, 99, 12]);
  assert.deepEqual(pidTree(10, { ps, exclude: [99] }), [10, 11, 12]);
  assert.deepEqual(pidTree(10, { ps: () => [], exclude: [] }), [10]);
  assert.deepEqual(pidTree(0, { ps }), []);
  assert.deepEqual(pidTree(Number.NaN, { ps }), []);
});

test("title comes from chat-meta and falls back to the project", () => {
  const root = mkdtempSync(join(tmpdir(), "freebuff-title-"));
  try {
    const chat = {
      dir: makeChat(root, "alpha", "2026-11-13T10-00-00.000Z", 111),
      project: "alpha",
      metaPath: join(root, "alpha", "chats", "2026-11-13T10-00-00.000Z", "chat-meta.json"),
    };
    assert.equal(readChatTitle(chat), "prompt of 2026-11-13T10-00-00.000Z");
    assert.equal(fallbackTitle(chat), "alpha");
    assert.equal(readChatTitle({ ...chat, metaPath: join(root, "missing.json") }), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
