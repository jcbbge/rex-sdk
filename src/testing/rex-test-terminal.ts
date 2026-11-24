/**
 * A scripted terminal block on {@link IRexTestServer}: its text, its output stream, typing, and
 * its program's exit, kept consistent with each other the way Rex keeps them.
 *
 * - `format` and `blob_read` read one snapshot of the text, in parts when `max_bytes` asks, with
 *   byte offsets and `total` as Rex reports them. Parts follow the observed contract in
 *   `docs/research/rex-blob-read.md`: `max_bytes` counts JSON-escaped characters, a part holds at
 *   least one character, and a read that starts inside a character shows each byte left of it as
 *   U+FFFD.
 * - The data stream starts with a snapshot and a `resize` message, then carries what the program
 *   prints and a `child_exited` message when it exits.
 * - `write` echoes typed text, as a shell does: it appears in the text and on the stream.
 *
 * @since 0.1.0
 */
import { Effect, Schema } from "effect";
import type { RexTerminalText } from "../rex-terminal-text.ts";
import {
  rexTestServerError,
  type IRexTestServer,
  type RexTestServerHandler,
} from "./rex-test-server.ts";

/** The test terminal's controls. */
export interface RexTestTerminal {
  /** The whole output, as `format` returns it with `trim` and `unwrap`. */
  readonly content: () => string;
  /** The program prints `text`: it is added to the output and sent on the stream. */
  readonly print: (text: string) => void;
  /** Replaces the output without sending stream bytes, as when scrollback is trimmed. */
  readonly replace: (content: string) => void;
  /** The program exits with `exitCode`. */
  readonly exit: (exitCode: number) => void;
  /** How many `format` requests were answered. */
  readonly reads: () => number;
}

/** Options for {@link startRexTestTerminal}. */
export interface RexTestTerminalOptions {
  /** The output already there; defaults to a shell prompt. */
  readonly content?: string | undefined;
  /** The exit code of a program that exited before the test started. */
  readonly exitedWith?: number | undefined;
  /** Whether `write` echoes typed text; defaults to true. */
  readonly echo?: boolean | undefined;
}

const NONCE = 7_777_777n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const rexMessage = (json: object) =>
  encoder.encode(`\u001b_rex1;${NONCE};${JSON.stringify(json)}\u001b\\`);

const FormatArgs = Schema.Struct({
  args: Schema.Struct({ max_bytes: Schema.optionalKey(Schema.Number) }),
});
const BlobReadArgs = Schema.Struct({
  args: Schema.Struct({
    id: Schema.Number,
    offset: Schema.optionalKey(Schema.Number),
    max_bytes: Schema.optionalKey(Schema.Number),
  }),
});
const WriteArgs = Schema.Struct({ args: Schema.Struct({ data: Schema.String }) });
const SessionArgs = Schema.Struct({ session_id: Schema.String });

/** What a character counts toward `max_bytes`, as Rex measures it: JSON-escaped, Go style. */
function escapedSize(lead: number, length: number): number {
  if (length > 1) return length;
  if (lead === 0x22 || lead === 0x5c || [0x0a, 0x0d, 0x09, 0x08, 0x0c].includes(lead)) return 2;
  if (lead < 0x20 || lead === 0x3c || lead === 0x3e || lead === 0x26) return 6;
  return 1;
}

/** The size of the UTF-8 character whose first byte is `lead`. */
function characterLength(lead: number): number {
  if (lead >= 0xf0) return 4;
  if (lead >= 0xe0) return 3;
  if (lead >= 0xc0) return 2;
  return 1;
}

/** The default and the cap Rex applies to `blob_read`'s `max_bytes`. */
const defaultBlobReadBytes = 49_152;
const maxBlobReadBytes = 983_040;

/**
 * One part of `bytes` from `offset`, as Rex returns it: whole characters up to `maxBytes` as
 * Rex measures them, at least one, with each byte of a character cut by `offset` shown as U+FFFD.
 */
function rexPart(bytes: Uint8Array, offset: number, maxBytes: number) {
  let cut = 0;
  let size = 0;
  let end = Math.min(offset, bytes.length);
  while (end < bytes.length) {
    const lead = bytes[end] ?? 0;
    const isCut = end - offset === cut && (lead & 0xc0) === 0x80;
    const length = isCut ? 1 : characterLength(lead);
    // U+2028 and U+2029 escape to six bytes, like the characters below U+0080 above.
    const lineSeparator = length === 3 && lead === 0xe2 && bytes[end + 1] === 0x80;
    const paragraph = lineSeparator && (bytes[end + 2] === 0xa8 || bytes[end + 2] === 0xa9);
    const cost = isCut ? 1 : paragraph ? 6 : escapedSize(lead, length);
    if (end > offset && size + cost > maxBytes) break;
    if (isCut) cut += 1;
    size += cost;
    end += length;
  }
  const data = "\uFFFD".repeat(cut) + decoder.decode(bytes.subarray(offset + cut, end));
  return { data, eof: end >= bytes.length };
}

interface TerminalState {
  content: string;
  exitCode: number | undefined;
  reads: number;
  readonly echo: boolean;
  readonly blobs: Map<number, Uint8Array>;
}

const BlockArgs = Schema.Struct({ block_id: Schema.String });

/** The terminals served on each test server, by block ID. */
const terminalsByServer = new WeakMap<IRexTestServer, Map<string, TerminalState>>();

/** Installs the handlers that route terminal methods to the block they name. */
function terminalsOf(server: IRexTestServer): Map<string, TerminalState> {
  const existing = terminalsByServer.get(server);
  if (existing !== undefined) return existing;
  const terminals = new Map<string, TerminalState>();
  terminalsByServer.set(server, terminals);
  let nextBlob = 1;

  const route =
    (
      handler: (state: TerminalState, payload: unknown, blockId: string) => Schema.Json,
    ): RexTestServerHandler =>
    (payload) =>
      Effect.sync(() => {
        const blockId = Schema.decodeUnknownSync(BlockArgs)(payload).block_id;
        const state = terminals.get(blockId);
        return state === undefined
          ? rexTestServerError("not_found", `no terminal ${blockId}`)
          : handler(state, payload, blockId);
      });

  server.handle("session.attach", (payload) =>
    Effect.sync(() => ({
      client_id: "client:01a1dddd-0000-0000-0000-000000000001",
      view: {
        revision: 1,
        session_id: Schema.decodeUnknownSync(SessionArgs)(payload).session_id,
        windows: [],
      },
    })),
  );
  server.handle(
    "com.superlogical.terminal.format",
    route((state, payload) => {
      state.reads += 1;
      const maxBytes = Schema.decodeUnknownSync(FormatArgs)(payload).args.max_bytes ?? 0;
      const bytes = encoder.encode(state.content);
      if (maxBytes === 0) return { content: state.content };
      const first = rexPart(bytes, 0, Math.min(maxBytes, maxBlobReadBytes));
      if (first.eof) return { content: first.data, total: bytes.length, eof: true };
      const id = nextBlob++;
      state.blobs.set(id, bytes);
      return { content: first.data, id, total: bytes.length, eof: false };
    }),
  );
  server.handle(
    "com.superlogical.terminal.blob_read",
    route((state, payload) => {
      const { id, offset = 0, max_bytes } = Schema.decodeUnknownSync(BlobReadArgs)(payload).args;
      const bytes = state.blobs.get(id) ?? new Uint8Array(0);
      const limit = Math.min(max_bytes || defaultBlobReadBytes, maxBlobReadBytes);
      return { id, ...rexPart(bytes, offset, limit), total: bytes.length };
    }),
  );
  server.handle(
    "com.superlogical.terminal.write",
    route((state, payload, blockId) => {
      const data = Schema.decodeUnknownSync(WriteArgs)(payload).args.data;
      if (state.echo) {
        const echoed = data.replaceAll("\r", "\n");
        state.content += echoed;
        server.sendData(blockId, encoder.encode(echoed));
      }
      return { bytes_written: encoder.encode(data).length };
    }),
  );
  server.handle(
    "com.superlogical.terminal.process",
    route((state) => ({
      last_exit: state.exitCode === undefined ? null : { exit_code: state.exitCode },
    })),
  );
  return terminals;
}

/**
 * Serves a terminal block on the test server, and session attaches. Several terminals can share
 * one server: terminal methods go to the block they name, and fail with `not_found` for others.
 *
 * @category constructors
 * @since 0.1.0
 */
export function startRexTestTerminal(
  server: IRexTestServer,
  target: { readonly sessionId: string; readonly blockId: string },
  options: RexTestTerminalOptions = {},
): RexTestTerminal {
  const state: TerminalState = {
    content: options.content ?? "user@host ~\n$ ",
    exitCode: options.exitedWith,
    reads: 0,
    echo: options.echo ?? true,
    blobs: new Map(),
  };
  terminalsOf(server).set(target.blockId, state);
  server.serveData({
    sessionId: target.sessionId,
    blockId: target.blockId,
    nonce: NONCE,
    chunks: [
      encoder.encode(`snapshot of ${target.blockId}`),
      rexMessage({ type: "resize", cols: 80, rows: 24 }),
    ],
  });

  return {
    content: () => state.content,
    print: (text) => {
      state.content += text;
      server.sendData(target.blockId, encoder.encode(text));
    },
    replace: (next) => {
      state.content = next;
    },
    exit: (code) => {
      state.exitCode = code;
      server.sendData(target.blockId, rexMessage({ type: "child_exited", exit_code: code }));
    },
    reads: () => state.reads,
  };
}

/**
 * What `terminals.readTail` should return for `content`, worked out from its bytes alone: every
 * line that starts within the last `maxBytes` bytes, with its byte offset and its trailing spaces
 * trimmed. Tests compare the SDK with it, against the test terminal and against a real server.
 */
export function referenceRexTerminalTail(content: string, maxBytes: number): RexTerminalText {
  const bytes = Buffer.from(content);
  const windowStart = Math.max(bytes.length - maxBytes, 0);
  const lines: string[] = [];
  const lineOffsets: number[] = [];
  let start = 0;
  for (let index = 0; index <= bytes.length; index += 1) {
    if (index < bytes.length && bytes[index] !== 0x0a) continue;
    if (start >= windowStart) {
      lines.push(
        bytes
          .subarray(start, index)
          .toString("utf8")
          .replace(/[ \t\r]+$/, ""),
      );
      lineOffsets.push(start);
    }
    start = index + 1;
  }
  while (lines.at(-1) === "") {
    lines.pop();
    lineOffsets.pop();
  }
  return { lines, lineOffsets, truncated: windowStart > 0 };
}
