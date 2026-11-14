import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const STATUS = fileURLToPath(new URL("../mods/freebuff-status/status.mjs", import.meta.url));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "freebuff-status-"));
  const home = join(root, "home");
  const config = join(home, ".config", "herdr-app");
  const modDir = join(config, "mods", "freebuff-status");
  const bin = join(root, "bin");
  const wrapperDir = join(home, ".local", "bin");
  mkdirSync(modDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(join(modDir, "freebuff-watcher.mjs"), "// watcher\n");

  const real = join(bin, "freebuff");
  writeFileSync(real, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(real, 0o755);

  const env = {
    ...process.env,
    HOME: home,
    HERDR_CONFIG_DIR: config,
    FREEBUFF_WRAPPER: join(wrapperDir, "freebuff"),
    PATH: `${wrapperDir}:${bin}:/usr/bin:/bin`,
  };
  delete env.HC_TERMINAL_ID;
  return { root, home, config, modDir, wrapperDir, real, env, wrapper: env.FREEBUFF_WRAPPER };
}

function run(env, ...args) {
  return execFileSync(process.execPath, [STATUS, ...args], { env, encoding: "utf8" });
}

function doctor(env) {
  return JSON.parse(run(env, "doctor"));
}

test("install writes the wrapper and registers the program", () => {
  const box = sandbox();
  try {
    run(box.env, "install");
    assert.ok(existsSync(box.wrapper));
    assert.match(readFileSync(box.wrapper, "utf8"), /# freebuff-status wrapper/);
    assert.ok(statSync(box.wrapper).mode & 0o111);

    const programs = JSON.parse(readFileSync(join(box.config, "programs.json"), "utf8"));
    assert.deepEqual(programs.programs.freebuff, {
      name: "Freebuff",
      icon: "mods/freebuff-status/robot.svg",
      tint: true,
      run: ["freebuff"],
    });

    const report = doctor(box.env);
    assert.equal(report.installed, true);
    assert.equal(report.wrapper, true);
    assert.equal(report.wrapperOurs, true);
    assert.equal(report.upToDate, true);
    assert.equal(report.program, true);
    assert.equal(report.wrapperInPath, true);
    assert.equal(report.inHerdr, false);
    assert.equal(report.freebuff, box.real);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("install is idempotent", () => {
  const box = sandbox();
  try {
    run(box.env, "install");
    run(box.env, "install");
    assert.equal(doctor(box.env).upToDate, true);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("install adds the icon to an entry from an older version", () => {
  const box = sandbox();
  try {
    const path = join(box.config, "programs.json");
    writeFileSync(path, JSON.stringify({ programs: { freebuff: { name: "Freebuff", run: ["freebuff"] } } }));

    run(box.env, "install");

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).programs.freebuff, {
      name: "Freebuff",
      icon: "mods/freebuff-status/robot.svg",
      tint: true,
      run: ["freebuff"],
    });
    const report = doctor(box.env);
    assert.equal(report.program, true);
    assert.equal(report.programCustomised, false);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("install leaves a foreign freebuff entry alone", () => {
  const box = sandbox();
  try {
    const path = join(box.config, "programs.json");
    const foreign = { name: "Mine", run: ["other-freebuff"] };
    writeFileSync(path, JSON.stringify({ programs: { freebuff: foreign } }));

    run(box.env, "install");

    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).programs.freebuff, foreign);
    assert.equal(doctor(box.env).programCustomised, true);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("install backs up a foreign wrapper once", () => {
  const box = sandbox();
  try {
    writeFileSync(box.wrapper, "#!/usr/bin/env bash\necho mine\n");
    run(box.env, "install");
    const backup = `${box.wrapper}.freebuff-status-backup`;
    assert.equal(readFileSync(backup, "utf8"), "#!/usr/bin/env bash\necho mine\n");
    assert.match(readFileSync(box.wrapper, "utf8"), /# freebuff-status wrapper/);

    writeFileSync(box.wrapper, "#!/usr/bin/env bash\necho changed\n");
    run(box.env, "install");
    assert.equal(readFileSync(backup, "utf8"), "#!/usr/bin/env bash\necho mine\n");
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("uninstall removes the wrapper and the program", () => {
  const box = sandbox();
  try {
    run(box.env, "install");
    run(box.env, "uninstall");
    assert.equal(existsSync(box.wrapper), false);
    const programs = JSON.parse(readFileSync(join(box.config, "programs.json"), "utf8"));
    assert.equal(programs.programs.freebuff, undefined);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("uninstall leaves a foreign wrapper unless forced", () => {
  const box = sandbox();
  try {
    writeFileSync(box.wrapper, "#!/usr/bin/env bash\necho mine\n");
    run(box.env, "uninstall");
    assert.ok(existsSync(box.wrapper));
    run(box.env, "uninstall", "--force");
    assert.equal(existsSync(box.wrapper), false);
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("uninstall keeps a customised program entry", () => {
  const box = sandbox();
  try {
    run(box.env, "install");
    const path = join(box.config, "programs.json");
    const data = JSON.parse(readFileSync(path, "utf8"));
    data.programs.freebuff.tile = "#123456";
    writeFileSync(path, JSON.stringify(data));
    assert.equal(doctor(box.env).programCustomised, true);

    run(box.env, "uninstall");
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(after.programs.freebuff, {
      name: "Freebuff",
      icon: "mods/freebuff-status/robot.svg",
      tint: true,
      run: ["freebuff"],
      tile: "#123456",
    });
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("path prints the exact locations", () => {
  const box = sandbox();
  try {
    const paths = JSON.parse(run(box.env, "path"));
    assert.equal(paths.modDir, box.modDir);
    assert.equal(paths.wrapperPath, box.wrapper);
    assert.equal(paths.programsPath, join(box.config, "programs.json"));
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});

test("an unknown command fails", () => {
  const box = sandbox();
  try {
    assert.throws(() => run(box.env, "nonsense"));
  } finally {
    rmSync(box.root, { recursive: true, force: true });
  }
});
