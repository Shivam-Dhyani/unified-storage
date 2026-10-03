/**
 * GramJS client lifecycle (TDD §6.5). One connected client per adapter instance.
 * Bot mode persists its StringSession to `sessionFile` (mode 600) so restarts do
 * not re-login (repeated bot logins can trigger FLOOD_WAIT). `floodSleepThreshold`
 * is 0 so every FLOOD_WAIT surfaces to our handler instead of being slept silently.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { TelegramClient, sessions } from 'telegram';

export interface TgClientConfig {
  apiId: number;
  apiHash: string;
  mode: 'bot' | 'user';
  /** bot mode. */
  botToken?: string;
  /** bot mode: where to persist the StringSession (mode 600). */
  sessionFile?: string;
  /** user mode: a pre-existing StringSession value. */
  session?: string;
  connectionRetries?: number;
}

export interface TgClientHandle {
  readonly client: TelegramClient;
  connect(): Promise<void>;
  close(): Promise<void>;
}

function readSessionFile(file: string): string {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

function persistSession(file: string, value: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // Non-fatal: the next run simply re-logs in.
  }
}

export function createTgClient(cfg: TgClientConfig): TgClientHandle {
  const initial =
    cfg.mode === 'bot' ? readSessionFile(cfg.sessionFile ?? '') : cfg.session ?? '';
  const session = new sessions.StringSession(initial);
  const client = new TelegramClient(session, cfg.apiId, cfg.apiHash, {
    connectionRetries: cfg.connectionRetries ?? 5,
    floodSleepThreshold: 0, // surface every FLOOD_WAIT to our handler
  });

  let started = false;

  return {
    client,
    async connect(): Promise<void> {
      if (started) return;
      if (cfg.mode === 'bot') {
        if (!cfg.botToken) throw new Error('bot mode requires botToken');
        if (initial) {
          await client.connect();
        } else {
          await client.start({ botAuthToken: cfg.botToken });
        }
        if (cfg.sessionFile) persistSession(cfg.sessionFile, String(client.session.save()));
      } else {
        await client.connect();
      }
      started = true;
    },
    async close(): Promise<void> {
      if (!started) return;
      await client.disconnect();
      await client.destroy();
      started = false;
    },
  };
}
