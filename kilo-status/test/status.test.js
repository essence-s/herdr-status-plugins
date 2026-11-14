import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  APP,
  MARKER,
  PLUGIN,
  configDir,
  doctor,
  install,
  pluginFile,
  sourceFile,
  uninstall,
} from "../mods/kilo-status/status.mjs";

function home() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-kilo-status-"));
  return { dir, env: { HOME: dir, XDG_CONFIG_HOME: join(dir, ".config") } };
}

test("configDir follows XDG_CONFIG_HOME", () => {
  assert.equal(configDir({ HOME: "/home/me", XDG_CONFIG_HOME: "/x" }), "/x/kilo");
  assert.equal(configDir({ HOME: "/home/me" }), "/home/me/.config/kilo");
  assert.equal(configDir({ HOME: "/home/me", XDG_CONFIG_HOME: "/x", KILO_CONFIG_DIR: "/k" }), "/k");
});

test("install copies the plugin, is idempotent, and uninstall removes it", () => {
  const { dir, env } = home();
  try {
    const dest = pluginFile(env);
    assert.equal(dest, join(dir, ".config", "kilo", "plugin", PLUGIN));

    assert.equal(install(env, { quiet: true }).changed, true);
    assert.equal(readFileSync(dest, "utf8"), readFileSync(sourceFile(), "utf8"));
    assert.match(readFileSync(dest, "utf8"), new RegExp(MARKER));

    assert.equal(install(env, { quiet: true }).changed, false);
    assert.equal(uninstall(env, { quiet: true }).changed, true);
    assert.equal(uninstall(env, { quiet: true }).changed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install keeps a backup of an edited copy", () => {
  const { dir, env } = home();
  try {
    const dest = pluginFile(env);
    mkdirSync(join(dir, ".config", "kilo", "plugin"), { recursive: true });
    writeFileSync(dest, "// my edit\n");

    install(env, { quiet: true });
    assert.equal(readFileSync(`${dest}.kilo-status-backup`, "utf8"), "// my edit\n");
    assert.equal(readFileSync(dest, "utf8"), readFileSync(sourceFile(), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall refuses a file it did not write unless forced", () => {
  const { dir, env } = home();
  try {
    const dest = pluginFile(env);
    mkdirSync(join(dir, ".config", "kilo", "plugin"), { recursive: true });
    writeFileSync(dest, "// someone else's plugin\n");

    assert.throws(() => uninstall(env, { quiet: true }), /not herdr-agent-state\.ts/);
    assert.equal(readFileSync(dest, "utf8"), "// someone else's plugin\n");

    assert.equal(uninstall(env, { quiet: true, force: true }).changed, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("KILO_CONFIG_DIR wins over XDG_CONFIG_HOME", () => {
  const { dir, env } = home();
  try {
    const profile = join(dir, "profile");
    const custom = { ...env, KILO_CONFIG_DIR: profile };
    install(custom, { quiet: true });
    assert.equal(readFileSync(join(profile, "plugin", PLUGIN), "utf8"), readFileSync(sourceFile(), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor reports installed, up to date, and Herdr", () => {
  const { dir, env } = home();
  try {
    let report = doctor({ ...env, HC_TERMINAL_ID: "t1" }, { version: false });
    assert.equal(report.installed, false);
    assert.equal(report.upToDate, false);
    assert.equal(report.inHerdr, true);
    assert.equal(report.app, APP);
    assert.equal(report.pluginFile, pluginFile(env));

    install(env, { quiet: true });
    report = doctor(env, { version: false });
    assert.equal(report.installed, true);
    assert.equal(report.ours, true);
    assert.equal(report.upToDate, true);
    assert.equal(report.inHerdr, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
