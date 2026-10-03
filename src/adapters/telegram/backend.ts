/**
 * Low-level Telegram backend contract. The adapter (index.ts) builds range
 * planning, FLOOD_WAIT retry, file-reference refresh, metrics and error mapping
 * on top of this. The GramJS implementation lives in backend-gramjs.ts and is
 * exercised by scripts/integration-telegram.ts; the adapter logic is unit-tested
 * against a fake backend.
 *
 * Telegram ids and access hashes are passed as strings (TDD §1.6). Byte offsets
 * and sizes are plain numbers (packs are <= 32 MB).
 */

export interface TgDocument {
  /** document id (string form of the MTProto long). */
  id: string;
  /** document access hash (string). */
  accessHash: string;
  /** current file reference (expires; refreshed via getDocument). */
  fileReference: Buffer;
  /** data-center the document lives on. */
  dcId: number;
  /** total document size in bytes. */
  size: number;
}

export interface ChannelHandle {
  channelId: string;
  accessHash: string;
  title: string;
  canPost: boolean;
  canDelete: boolean;
}

export interface UploadArgs {
  channelId: string;
  accessHash: string;
  data: Buffer;
  name: string;
  caption?: string;
}

export interface MessageArgs {
  channelId: string;
  accessHash: string;
  messageId: string;
}

export interface TelegramBackend {
  connect(): Promise<void>;
  close(): Promise<void>;

  /** Bot mode: resolve a channel for MTProto file ops (U-04). */
  resolveChannel(channelId: string): Promise<ChannelHandle>;

  uploadDocument(args: UploadArgs): Promise<{ messageId: string }>;

  /** Fresh document descriptor for a stored message; undefined if missing / not a document. */
  getDocument(args: MessageArgs): Promise<TgDocument | undefined>;

  /** Raw ranged read. MAY throw FloodWaitError / FILE_REFERENCE errors (the adapter handles them). */
  getFilePart(doc: TgDocument, offset: number, limit: number): Promise<Buffer>;

  deleteMessage(args: MessageArgs): Promise<void>;

  leaveChannel(args: { channelId: string; accessHash: string }): Promise<void>;

  // --- user-session mode (FR-PKG-03), used by PocketVerse later ---

  /** User mode: find a channel the user owns whose `about` contains `marker`. */
  findChannelByMarker?(marker: string): Promise<ChannelHandle | undefined>;

  /** User mode: create a channel with the given title and description. */
  createChannel?(args: { title: string; about: string }): Promise<ChannelHandle>;
}
