/** Minimal, dependency-free .env loader for the integration/bench scripts. */

import { existsSync, readFileSync } from 'node:fs';

/** Load KEY=VALUE lines from a .env file into process.env (without overriding existing vars). */
export function loadDotenv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    console.error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(2);
  }
  return v;
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v === '' ? undefined : v;
}
