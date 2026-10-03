/**
 * In-memory TelegramBackend for unit-testing the adapter orchestration
 * (range planning, reassembly, file-reference refresh, idempotent delete)
 * without any network.
 */

import type {
  ChannelHandle,
  MessageArgs,
  TelegramBackend,
  TgDocument,
  UploadArgs,
} from '../../src/adapters/telegram/backend.js';

export interface FakeBackendOptions {
  /** throw FILE_REFERENCE_EXPIRED on the very first getFilePart, then succeed. */
  failFileRefOnce?: boolean;
}

export interface FakeBackend extends TelegramBackend {
  counters: { getDocument: number; getFilePart: number; upload: number; delete: number; resolve: number };
  docs: Map<string, Buffer>;
}

export function createFakeTelegramBackend(options: FakeBackendOptions = {}): FakeBackend {
  const docs = new Map<string, Buffer>();
  const counters = { getDocument: 0, getFilePart: 0, upload: 0, delete: 0, resolve: 0 };
  let msgSeq = 0;
  let failedOnce = false;

  const msgIdFromDoc = (docId: string): string => docId.replace(/^doc/, '');

  return {
    counters,
    docs,

    async connect() {},
    async close() {},

    async resolveChannel(channelId: string): Promise<ChannelHandle> {
      counters.resolve++;
      return { channelId, accessHash: `ah-${channelId}`, title: `Channel ${channelId}`, canPost: true, canDelete: true };
    },

    async uploadDocument(args: UploadArgs): Promise<{ messageId: string }> {
      counters.upload++;
      const messageId = String(++msgSeq);
      docs.set(messageId, Buffer.from(args.data));
      return { messageId };
    },

    async getDocument(args: MessageArgs): Promise<TgDocument | undefined> {
      counters.getDocument++;
      const buf = docs.get(args.messageId);
      if (!buf) return undefined;
      return {
        id: `doc${args.messageId}`,
        accessHash: 'ah',
        fileReference: Buffer.from([counters.getDocument & 0xff]), // changes across refreshes
        dcId: 2,
        size: buf.length,
      };
    },

    async getFilePart(doc: TgDocument, offset: number, limit: number): Promise<Buffer> {
      counters.getFilePart++;
      if (options.failFileRefOnce && !failedOnce) {
        failedOnce = true;
        throw new Error('FILE_REFERENCE_EXPIRED');
      }
      const buf = docs.get(msgIdFromDoc(doc.id));
      if (!buf) throw new Error('MESSAGE_ID_INVALID');
      return Buffer.from(buf.subarray(offset, offset + limit));
    },

    async deleteMessage(args: MessageArgs): Promise<void> {
      counters.delete++;
      if (!docs.has(args.messageId)) throw new Error('MESSAGE_ID_INVALID');
      docs.delete(args.messageId);
    },

    async leaveChannel(): Promise<void> {},
  };
}
