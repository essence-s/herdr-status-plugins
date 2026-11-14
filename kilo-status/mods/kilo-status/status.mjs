#!/usr/bin/env node
// herdr-kilo-status: Kilo Code terminals report their status to Herdr.
//
// The work is done by herdr-agent-state.ts, a Kilo server plugin that writes
// OSC 7501 to the terminal. This script puts that plugin in Kilo's plugin
// folder, takes it out again, and says what it finds.
//
//   status.mjs install      copy the plugin to <kilo config>/plugin/
//   status.mjs uninstall    remove it again (--force removes a modified copy)
//   status.mjs doctor       JSON: installed, up to date, where, Herdr around?
//   status.mjs path         print the plugin file it uses

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The installed file's name inside Kilo's `plugin/` folder. */
export const PLUGIN = "herdr-agent-state.ts";

/** A marker in the plugin, so uninstall never deletes a file it didn't write. */
export const MARKER = "// herdr-kilo-status";

/** The 7501 `app`, matching Herdr's `kilocode` program. */
export const APP = "kilocode";

const SELF = fileURLToPath(import.meta.url);

/** The plugin shipped next to this script. */
export const sourceFile = () => join(dirname(SELF), PLUGIN);

/** Kilo's config directory: KILO_CONFIG_DIR, else XDG_CONFIG_HOME/kilo, else ~/.config/kilo. */
export function configDir(env = process.env) {
  if (env.KILO_CONFIG_DIR) return env.KILO_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "kilo");
}

/** Where the plugin lives once installed. */
export function pluginFile(env = process.env) {
  return join(configDir(env), "plugin", PLUGIN);
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Copies the plugin into Kilo's plugin folder. Idempotent: the same content is
 * left alone. A different file at our path is backed up once before it is
 * replaced, so an edited copy is never lost silently.
 */
export function install(env = process.env, { quiet = false } = {}) {
  const source = sourceFile();
  const text = read(source);
  if (text === null) throw new Error(`missing ${source}; run this from the package's mods/kilo-status folder.`);

  const dest = pluginFile(env);
  mkdirSync(dirname(dest), { recursive: true });

  const old = read(dest);
  if (old === text) {
    if (!quiet) process.stdout.write(`Already installed: ${dest}\n`);
    return { changed: false, file: dest };
  }

  if (old !== null) {
    const backup = `${dest}.kilo-status-backup`;
    if (!existsSync(backup)) copyFileSync(dest, backup);
  }

  const tmp = `${dest}.kilo-status-${process.pid}.tmp`;
  copyFileSync(source, tmp);
  chmodSync(tmp, 0o644);
  renameSync(tmp, dest);

  if (!quiet) {
    process.stdout.write(`${old === null ? "Installed" : "Updated"}: ${dest}\n`);
    process.stdout.write("Restart Kilo (or start a new terminal) so it loads the plugin.\n");
  }
  return { changed: true, file: dest };
}

/**
 * Removes the plugin, but only a file carrying our marker. `force` removes
 * whatever is at that path.
 */
export function uninstall(env = process.env, { quiet = false, force = false } = {}) {
  const dest = pluginFile(env);
  const text = read(dest);

  if (text === null) {
    if (!quiet) process.stdout.write(`Not installed: ${dest}\n`);
    return { changed: false, file: dest };
  }

  if (!force && !text.includes(MARKER)) {
    throw new Error(`${dest} is not ${PLUGIN}; leaving it alone (use --force to remove it).`);
  }

  rmSync(dest);
  if (!quiet) {
    process.stdout.write(`Removed: ${dest}\n`);
    process.stdout.write("Restart Kilo so the plugin stops.\n");
  }
  return { changed: true, file: dest };
}

/** Everything a bug report needs, as JSON. */
export function doctor(env = process.env, { version = true } = {}) {
  const file = pluginFile(env);
  const installed = read(file);
  const source = read(sourceFile());

  let kilo = null;
  if (version) {
    try {
      kilo = execFileSync("kilo", ["--version"], {
        encoding: "utf8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Kilo isn't on PATH; the rest of the report is still useful.
    }
  }

  return {
    installed: installed !== null,
    ours: Boolean(installed && installed.includes(MARKER)),
    upToDate: installed !== null && source !== null && installed === source,
    pluginFile: file,
    configDir: configDir(env),
    source: sourceFile(),
    app: APP,
    inHerdr: Boolean(env.HC_TERMINAL_ID),
    kilo,
    node: process.version,
    restart: "Restart Kilo (or start a new terminal) after installing.",
  };
}

const COMMANDS = {
  install: () => install(),
  uninstall: (args) => uninstall(process.env, { force: args.includes("--force") }),
  doctor: () => process.stdout.write(JSON.stringify(doctor(), null, 2) + "\n"),
  path: () => process.stdout.write(pluginFile() + "\n"),
};

const USAGE = `usage: status.mjs ${Object.keys(COMMANDS).join("|")}\n`;

async function main() {
  const [name, ...args] = process.argv.slice(2);
  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  try {
    await command(args);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) main();
