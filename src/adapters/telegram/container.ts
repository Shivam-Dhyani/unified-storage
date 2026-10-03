/**
 * Channel "containers" (TDD §6.5).
 *  - bot mode: `attachChannel` resolves a channel for MTProto file ops (U-04).
 *  - user mode: `findOrCreateChannel` finds the storage channel by marker, and
 *    only creates one when none exists — never a duplicate on reconnect (the
 *    PocketVerse bug, FR-PKG-03).
 */

import { StorageError } from '../../errors.js';
import type { ChannelHandle, TelegramBackend } from './backend.js';

export function attachChannel(backend: TelegramBackend, channelId: string): Promise<ChannelHandle> {
  return backend.resolveChannel(channelId);
}

export async function findOrCreateChannel(
  backend: TelegramBackend,
  params: { marker: string; title: string },
): Promise<ChannelHandle> {
  if (!backend.findChannelByMarker || !backend.createChannel) {
    throw new StorageError('CONFIG', 'user-session backend required for findOrCreateChannel');
  }
  const existing = await backend.findChannelByMarker(params.marker);
  if (existing) return existing;
  // The channel description MUST contain the exact marker so it can be found again.
  return backend.createChannel({ title: params.title, about: params.marker });
}
