/**
 * Real GramJS implementation of `TelegramBackend` (TDD §6.5). Exercised by
 * scripts/integration-telegram.ts; the adapter orchestration on top is unit
 * tested against a fake backend.
 */

import { Api, helpers } from 'telegram';
import { CustomFile } from 'telegram/client/uploads.js';

import type {
  ChannelHandle,
  MessageArgs,
  TelegramBackend,
  TgDocument,
  UploadArgs,
} from './backend.js';
import { createTgClient, type TgClientHandle } from './client.js';

export type GramjsBackendOptions =
  | { mode: 'bot'; apiId: number; apiHash: string; botToken: string; sessionFile: string }
  | { mode: 'user'; apiId: number; apiHash: string; session: string };

const big = helpers.returnBigInt;

export function createGramjsBackend(options: GramjsBackendOptions): TelegramBackend {
  const handle: TgClientHandle =
    options.mode === 'bot'
      ? createTgClient({
          mode: 'bot',
          apiId: options.apiId,
          apiHash: options.apiHash,
          botToken: options.botToken,
          sessionFile: options.sessionFile,
        })
      : createTgClient({
          mode: 'user',
          apiId: options.apiId,
          apiHash: options.apiHash,
          session: options.session,
        });

  const client = handle.client;

  const inputPeer = (channelId: string, accessHash: string): Api.InputPeerChannel =>
    new Api.InputPeerChannel({ channelId: big(channelId), accessHash: big(accessHash) });

  const inputChannel = (channelId: string, accessHash: string): Api.InputChannel =>
    new Api.InputChannel({ channelId: big(channelId), accessHash: big(accessHash) });

  return {
    connect: () => handle.connect(),
    close: () => handle.close(),

    async resolveChannel(channelId: string): Promise<ChannelHandle> {
      const res = (await client.invoke(
        new Api.channels.GetChannels({
          id: [new Api.InputChannel({ channelId: big(channelId), accessHash: big(0) })],
        }),
      )) as { chats: Api.TypeChat[] };
      const chat = res.chats.find((c): c is Api.Channel => c instanceof Api.Channel);
      if (!chat) throw new Error('CHANNEL_INVALID');
      const admin = chat.adminRights;
      return {
        channelId: String(chat.id),
        accessHash: String(chat.accessHash ?? '0'),
        title: chat.title ?? '',
        canPost: Boolean(admin?.postMessages),
        canDelete: Boolean(admin?.deleteMessages),
      };
    },

    async uploadDocument(args: UploadArgs): Promise<{ messageId: string }> {
      const file = new CustomFile(args.name, args.data.length, '', args.data);
      const msg = await client.sendFile(inputPeer(args.channelId, args.accessHash), {
        file,
        forceDocument: true,
        workers: 4,
        ...(args.caption !== undefined ? { caption: args.caption } : {}),
      });
      return { messageId: String(msg.id) };
    },

    async getDocument(args: MessageArgs): Promise<TgDocument | undefined> {
      const msgs = await client.getMessages(inputPeer(args.channelId, args.accessHash), {
        ids: [Number(args.messageId)],
      });
      const msg = msgs[0];
      if (!msg || !msg.media || !(msg.media instanceof Api.MessageMediaDocument)) return undefined;
      const doc = msg.media.document;
      if (!doc || !(doc instanceof Api.Document)) return undefined;
      return {
        id: String(doc.id),
        accessHash: String(doc.accessHash),
        fileReference: Buffer.from(doc.fileReference),
        dcId: doc.dcId,
        size: Number(doc.size),
      };
    },

    async getFilePart(doc: TgDocument, offset: number, limit: number): Promise<Buffer> {
      const result = await client.invoke(
        new Api.upload.GetFile({
          location: new Api.InputDocumentFileLocation({
            id: big(doc.id),
            accessHash: big(doc.accessHash),
            fileReference: doc.fileReference,
            thumbSize: '',
          }),
          offset: big(offset),
          limit,
        }),
        doc.dcId,
      );
      if (!(result instanceof Api.upload.File)) {
        throw new Error('unexpected upload.getFile response (CDN redirect not supported)');
      }
      return Buffer.from(result.bytes);
    },

    async deleteMessage(args: MessageArgs): Promise<void> {
      await client.deleteMessages(inputPeer(args.channelId, args.accessHash), [Number(args.messageId)], {});
    },

    async leaveChannel(args: { channelId: string; accessHash: string }): Promise<void> {
      await client.invoke(
        new Api.channels.LeaveChannel({ channel: inputChannel(args.channelId, args.accessHash) }),
      );
    },

    async findChannelByMarker(marker: string): Promise<ChannelHandle | undefined> {
      const dialogs = await client.getDialogs({});
      for (const d of dialogs) {
        const ent = d.entity;
        if (!(ent instanceof Api.Channel) || !ent.creator) continue;
        const full = await client.invoke(
          new Api.channels.GetFullChannel({
            channel: new Api.InputChannel({ channelId: ent.id, accessHash: ent.accessHash ?? big(0) }),
          }),
        );
        const fullChat = full.fullChat;
        const about = fullChat instanceof Api.ChannelFull ? fullChat.about : '';
        if (about && about.includes(marker)) {
          return {
            channelId: String(ent.id),
            accessHash: String(ent.accessHash ?? '0'),
            title: ent.title,
            canPost: true,
            canDelete: true,
          };
        }
      }
      return undefined;
    },

    async createChannel(args: { title: string; about: string }): Promise<ChannelHandle> {
      const res = await client.invoke(
        new Api.channels.CreateChannel({ title: args.title, about: args.about, broadcast: true }),
      );
      const chats = (res as { chats?: Api.TypeChat[] }).chats ?? [];
      const ch = chats.find((c): c is Api.Channel => c instanceof Api.Channel);
      if (!ch) throw new Error('channel creation returned no channel');
      return {
        channelId: String(ch.id),
        accessHash: String(ch.accessHash ?? '0'),
        title: ch.title,
        canPost: true,
        canDelete: true,
      };
    },
  };
}
