#!/usr/bin/env node
/**
 * Applique NATIVE_APP_URL dans capacitor.config.json puis exécute `cap <args>`.
 * Usage: node scripts/with-native-url.mjs sync
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const configPath = path.join(root, "capacitor.config.json");
const DEFAULT_URL = "https://sidour-avoda-website.vercel.app";

const url = String(process.env.NATIVE_APP_URL || DEFAULT_URL).replace(/\/$/, "");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.server = config.server || {};
config.server.url = url;
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`NATIVE_APP_URL -> ${url}`);

const args = process.argv.slice(2);
if (args.length === 0) process.exit(0);

const result = spawnSync("npx", ["cap", ...args], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
