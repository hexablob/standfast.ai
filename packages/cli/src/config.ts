import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Credentials live in the user's config directory, never in the project tree.
 *
 * A key sitting next to the code gets committed eventually, and it also
 * implies the repository depends on it, which it does not — the CLI is a
 * client, and a clone of this repository needs no credential to build or test.
 */

export type Config = {
  baseUrl: string;
  apiKey: string;
};

export const DEFAULT_BASE_URL = "http://localhost:8080";

export function configDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return join(
    xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"),
    "standfast",
  );
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/**
 * Environment beats the file, so CI can run without writing a credential to
 * disk at all.
 */
export async function loadConfig(): Promise<Partial<Config>> {
  const fromEnv: Partial<Config> = {};
  const envKey = process.env["STANDFAST_API_KEY"];
  const envUrl = process.env["STANDFAST_BASE_URL"];
  if (envKey) {
    fromEnv.apiKey = envKey;
  }
  if (envUrl) {
    fromEnv.baseUrl = envUrl;
  }

  let fromFile: Partial<Config> = {};
  try {
    fromFile = JSON.parse(
      await readFile(configPath(), "utf8"),
    ) as Partial<Config>;
  } catch {
    // No config yet is the normal state before `standfast login`.
  }

  return { ...fromFile, ...fromEnv };
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  // mkdir/writeFile modes are masked by umask, so set it explicitly rather
  // than hoping. A world-readable file holding an API key is the whole
  // problem.
  await chmod(path, 0o600);
}

export async function clearConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}

/** Shows enough of a key to recognise it, never enough to use it. */
export function redactKey(key: string): string {
  return key.length <= 14 ? "…" : `${key.slice(0, 14)}…`;
}
