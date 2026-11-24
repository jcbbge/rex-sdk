/**
 * Byte streams through public services: downloads, pastes, and tunnels against the test server.
 *
 * The test server plays Rex's side of `rex.data.bytes.v1` as `docs/research/rex-data-bytes-v1.md`
 * records it: raw binary messages, an empty message as a half-close, and close 1000 only after a
 * half-close. Every test checks what crossed the wire, not only what the SDK returned.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, Option, Schema, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { BlockId, SessionId } from "./rex-domain.ts";
import { RexSdk } from "./rex-sdk.ts";
import { runRexSdkTest } from "./testing/rex-test-runtime.ts";
import type {
  IRexTestServer,
  RexTestServerBytesConnection,
  RexTestServerBytesPeer,
} from "./testing/rex-test-server.ts";

const sessionId = SessionId.make("session:01a1aaaa-0000-0000-0000-000000000001");
const blockId = BlockId.make("block:01a1bbbb-0000-0000-0000-000000000001");
const target = { sessionId, blockId };
const file = {
  path: "/srv/app/report.csv",
  name: "report.csv",
  size: 11,
  modified_at: "2026-11-23T06:36:08Z",
  version: "I5zwfEJdv4CWbGzJdRx9lA",
};
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);
const empty = new Uint8Array(0);

const failureTags = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag))
    : ["Success"];

const decodeObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Json));
const argsOf = (payload: unknown) => decodeObject(decodeObject(payload)["args"]);
const refOf = (payload: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ args: Schema.Struct({ ref: Schema.String }) }))(payload)
    .args.ref;

function handleAttach(server: IRexTestServer) {
  server.handle("session.attach", () =>
    Effect.succeed({
      client_id: "client:test-1",
      view: { revision: 1, session_id: sessionId, windows: [] },
    }),
  );
}

/** Answers `download_begin` with a ticket whose stream `peer` plays. */
function serveDownload(server: IRexTestServer, peer: RexTestServerBytesPeer) {
  server.handle("com.superlogical.terminal.download_begin", (payload) =>
    Effect.sync(() => ({
      ...file,
      ticket: server.issueBytesTicket(refOf(payload), peer),
      expires_in_ms: 60_000,
    })),
  );
}

/** Rex's side of a finished download: the bytes, the empty end marker, then close 1000. */
const sendsFile =
  (...chunks: ReadonlyArray<Uint8Array>): RexTestServerBytesPeer =>
  (connection) => {
    for (const chunk of chunks) connection.send(chunk);
    connection.send(empty);
    connection.close(1000);
  };

/** Rex's side of an upload: closes 1000 once the client half-closes. */
const acceptsUpload: RexTestServerBytesPeer = (connection) =>
  connection.onMessage((chunk) => {
    if (chunk.length === 0) connection.close(1000);
  });

/** Rex's side of a tunnel to an echo target: echoes, then half-closes and closes after the client. */
const echoes: RexTestServerBytesPeer = (connection: RexTestServerBytesConnection) =>
  connection.onMessage((chunk) => {
    if (chunk.length === 0) {
      connection.send(empty);
      connection.close(1000);
      return;
    }
    connection.send(bytes(`echo:${text(chunk)}`));
  });

const lastStream = (server: IRexTestServer) => server.bytesStreams().at(-1);

describe("downloads", () => {
  test("stream the file's bytes, then end only after the end marker and a 1000 close", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        serveDownload(server, sendsFile(bytes("hello "), bytes("world")));
        const rex = yield* RexSdk;
        const contents = yield* rex.terminals.readFile(target, "report.csv");
        expect(text(contents.bytes)).toBe("hello world");
        expect(contents.file).toEqual({
          path: file.path,
          name: file.name,
          size: 11,
          modifiedAt: file.modified_at,
          version: Option.some(file.version),
        });
        // The ticket never reaches the caller.
        expect(Object.keys(contents.file)).not.toContain("ticket");
        const sent = server.requestsFor("com.superlogical.terminal.download_begin")[0];
        expect(argsOf(sent?.payload)).toEqual({
          ref: expect.stringMatching(
            /^download:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
          path: "report.csv",
        });
      }),
    ));

  test("answer NotModified without opening a stream when the version is current", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("com.superlogical.terminal.download_begin", () =>
          Effect.succeed({ ...file, not_modified: true }),
        );
        const rex = yield* RexSdk;
        const result = yield* Effect.scoped(
          rex.terminals.download(target, file.path, { ifNoneMatch: file.version }),
        );
        expect(result._tag).toBe("NotModified");
        expect(server.bytesStreams()).toEqual([]);
        expect(
          argsOf(server.requestsFor("com.superlogical.terminal.download_begin")[0]?.payload)[
            "if_none_match"
          ],
        ).toBe(file.version);
      }),
    ));

  test("fail as incomplete when the stream closes 1000 without the end marker", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        serveDownload(server, (connection) => {
          connection.send(bytes("hello"));
          connection.close(1000);
        });
        const rex = yield* RexSdk;
        const exit = yield* Effect.exit(rex.terminals.readFile(target, file.path));
        expect(failureTags(exit)).toEqual(["RexTransferIncomplete"]);
      }),
    ));

  test("report a closed block and a failed read with their own errors", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        const rex = yield* RexSdk;
        serveDownload(server, (connection) => connection.close(4000, "block closed"));
        const closed = yield* Effect.exit(rex.terminals.readFile(target, file.path));
        expect(failureTags(closed)).toEqual(["RexBlockClosed"]);
        serveDownload(server, (connection) => connection.close(1011, "data provider failed"));
        const failed = yield* Effect.exit(rex.terminals.readFile(target, file.path));
        expect(failureTags(failed)).toEqual(["RexDataStreamFailed"]);
      }),
    ));

  test("stop past maxBytes and after a stall, aborting the stream", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        const rex = yield* RexSdk;
        serveDownload(server, (connection) => {
          connection.send(bytes("0123456789"));
          connection.send(bytes("0123456789"));
        });
        const large = yield* Effect.exit(
          rex.terminals.readFile(target, file.path, { maxBytes: 15 }),
        );
        expect(failureTags(large)).toEqual(["RexTransferTooLarge"]);
        yield* Effect.sleep("50 millis");
        expect(lastStream(server)?.closed?.code).toBe(4001);

        serveDownload(server, (connection) => connection.send(bytes("partial")));
        const stalled = yield* Effect.exit(
          rex.terminals.readFile(target, file.path, { stallTimeout: "100 millis" }),
        );
        expect(failureTags(stalled)).toEqual(["RexTransferStalled"]);
        yield* Effect.sleep("50 millis");
        expect(lastStream(server)?.closed?.code).toBe(4001);
      }),
    ));

  test("stop when the server sends the end marker but never closes, within the stall timeout", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        const rex = yield* RexSdk;
        serveDownload(server, (connection) => {
          connection.send(bytes("hello"));
          connection.send(empty);
        });
        // The outer deadline keeps a regression from hanging the suite.
        const unclosed = yield* Effect.exit(
          rex.terminals.readFile(target, file.path, { stallTimeout: "100 millis" }),
        ).pipe(Effect.timeoutOption("2 seconds"));
        expect(Option.map(unclosed, failureTags)).toEqual(Option.some(["RexTransferStalled"]));
        yield* Effect.sleep("50 millis");
        expect(lastStream(server)?.closed?.code).toBe(4001);

        // A close that follows the end marker within the stall timeout still succeeds.
        serveDownload(server, (connection) => {
          connection.send(bytes("hello"));
          connection.send(empty);
          setTimeout(() => connection.close(1000), 50);
        });
        const contents = yield* rex.terminals
          .readFile(target, file.path, { stallTimeout: "300 millis" })
          .pipe(Effect.timeout("2 seconds"));
        expect(text(contents.bytes)).toBe("hello");
        yield* Effect.sleep("50 millis");
        expect(lastStream(server)?.closed?.code).toBe(1000);
      }),
    ));

  test("cancel with close 4001 when the scope closes before the download finishes", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        serveDownload(server, (connection) => connection.send(bytes("first part")));
        const rex = yield* RexSdk;
        const first = yield* Effect.scoped(
          Effect.gen(function* () {
            const download = yield* rex.terminals.download(target, file.path);
            if (download._tag !== "Download") return "";
            const chunk = yield* Stream.runHead(download.bytes);
            return Option.match(chunk, { onNone: () => "", onSome: text });
          }),
        );
        expect(first).toBe("first part");
        yield* Effect.sleep("50 millis");
        expect(lastStream(server)?.closed).toEqual({ code: 4001, reason: "cancelled" });
      }),
    ));

  test("downloadToFile renames into place only when complete, and leaves nothing on failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "rex-sdk-download-"));
    return runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        const rex = yield* RexSdk;
        const destination = join(directory, "report.csv");
        serveDownload(server, sendsFile(bytes("hello "), bytes("world")));
        const done = yield* rex.terminals.downloadToFile(target, file.path, destination);
        expect(done).toMatchObject({ _tag: "Downloaded", destination, bytesWritten: 11 });
        expect(readFileSync(destination, "utf8")).toBe("hello world");

        serveDownload(server, (connection) => {
          connection.send(bytes("half"));
          connection.close(1011, "data provider failed");
        });
        const failed = yield* Effect.exit(
          rex.terminals.downloadToFile(target, file.path, join(directory, "broken.csv")),
        );
        expect(failureTags(failed)).toEqual(["RexDataStreamFailed"]);
        expect(readdirSync(directory)).toEqual(["report.csv"]);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    ).finally(() => rmSync(directory, { recursive: true, force: true }));
  });
});

describe("pasteFiles", () => {
  test("sends exactly the declared bytes and the half-close, one stream per file in a batch", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("com.superlogical.terminal.upload_begin", (payload) =>
          Effect.sync(() => ({
            ticket: server.issueBytesTicket(refOf(payload), acceptsUpload),
            expires_in_ms: 60_000,
          })),
        );
        const rex = yield* RexSdk;
        const large = new Uint8Array(150_000).fill(7);
        yield* rex.terminals.pasteFiles(target, [
          { name: "notes.txt", data: "hello" },
          {
            name: "image.png",
            size: large.length,
            stream: Stream.make(large.subarray(0, 100_000), large.subarray(100_000)),
          },
        ]);
        const args = server
          .requestsFor("com.superlogical.terminal.upload_begin")
          .map((request) => argsOf(request.payload));
        expect(args).toEqual([
          {
            ref: expect.stringMatching(/^upload:/),
            name: "notes.txt",
            size: 5,
            batch: expect.any(String),
            index: 0,
            count: 2,
          },
          {
            ref: expect.stringMatching(/^upload:/),
            name: "image.png",
            size: 150_000,
            batch: args[0]?.["batch"],
            index: 1,
            count: 2,
          },
        ]);
        yield* Effect.sleep("50 millis");
        const [notes, image] = server.bytesStreams();
        expect(notes?.received.map(text)).toEqual(["hello", ""]);
        // Sent in messages of at most 64 KiB, then the half-close.
        expect(image?.received.map((chunk) => chunk.length)).toEqual([65_536, 34_464, 50_000, 0]);
        expect(image?.closed?.code).toBe(1000);
      }),
    ));

  test("refuses a stream shorter than its declared size, without a half-close", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("com.superlogical.terminal.upload_begin", (payload) =>
          Effect.sync(() => ({
            ticket: server.issueBytesTicket(refOf(payload), acceptsUpload),
            expires_in_ms: 60_000,
          })),
        );
        const rex = yield* RexSdk;
        const exit = yield* Effect.exit(
          rex.terminals.pasteFiles(target, [
            { name: "short.bin", size: 10, stream: Stream.make(bytes("abc")) },
          ]),
        );
        expect(failureTags(exit)).toEqual(["RexTransferIncomplete"]);
        yield* Effect.sleep("50 millis");
        const stream = lastStream(server);
        expect(stream?.received.map(text)).toEqual(["abc"]);
        expect(stream?.closed?.code).toBe(4001);
        // A single file is not a batch.
        expect(
          argsOf(server.requestsFor("com.superlogical.terminal.upload_begin")[0]?.payload),
        ).not.toHaveProperty("batch");
      }),
    ));
});

/** A TCP echo server on this machine, for the far end of a remote forward. */
function startEchoServer() {
  return Effect.acquireRelease(
    Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
      const echo = createServer({ allowHalfOpen: true }, (socket) => {
        socket.on("data", (data) => socket.write(`echo:${data.toString()}`));
        socket.on("end", () => socket.end());
      });
      echo.listen(0, "127.0.0.1", () => {
        const address = echo.address();
        resume(
          Effect.succeed({
            port: address !== null && typeof address === "object" ? address.port : 0,
            close: () => echo.close(),
          }),
        );
      });
    }),
    (echo) => Effect.sync(echo.close),
  );
}

/** Connects, sends `message`, half-closes, and collects everything until the peer's FIN. */
function roundTrip(address: string, message: string) {
  const separator = address.lastIndexOf(":");
  const host = address.slice(0, separator);
  const port = Number(address.slice(separator + 1));
  return Effect.callback<string, Error>((resume) => {
    const socket: Socket = connect({ host, port, allowHalfOpen: true }, () => {
      socket.write(message);
      socket.end();
    });
    let received = "";
    socket.on("data", (data) => {
      received += data.toString();
    });
    socket.on("end", () => resume(Effect.succeed(received)));
    socket.on("error", (error) => resume(Effect.fail(error)));
  });
}

describe("tunnels", () => {
  test("openStream carries bytes both ways with half-closes, over a conn: reference", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.serveBytes(blockId, () => echoes);
        const rex = yield* RexSdk;
        const reply = yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* rex.tunnels.openStream(target);
            yield* stream.write(bytes("ping"));
            yield* stream.end;
            const chunks = yield* Stream.runCollect(stream.incoming);
            yield* stream.done;
            return chunks.map(text).join("");
          }),
        );
        expect(reply).toBe("echo:ping");
        expect(server.requestsFor("data.connect")[0]?.payload).toEqual({
          session_id: sessionId,
          block_id: blockId,
          data_ref_id: expect.stringMatching(/^conn:/),
          subprotocol: "rex.data.bytes.v1",
        });
      }),
    ));

  test("openStream stays open after the server's half-close until this side finishes", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        const received: Array<string> = [];
        server.serveBytes(blockId, () => (connection) => {
          connection.send(bytes("bye"));
          connection.send(empty);
          connection.onMessage((chunk) => {
            if (chunk.length === 0) connection.close(1000);
            else received.push(text(chunk));
          });
        });
        const rex = yield* RexSdk;
        const reply = yield* Effect.scoped(
          Effect.gen(function* () {
            const stream = yield* rex.tunnels.openStream(target);
            const chunks = yield* Stream.runCollect(stream.incoming);
            // An idle half-open TCP connection is not a stall.
            yield* Effect.sleep("300 millis");
            yield* stream.write(bytes("late"));
            yield* stream.end;
            yield* stream.done;
            return chunks.map(text).join("");
          }),
        );
        expect(reply).toBe("bye");
        expect(received).toEqual(["late"]);
        yield* Effect.sleep("50 millis");
        expect(lastStream(server)?.closed?.code).toBe(1000);
      }),
    ));

  test("forwardLocal listens here and carries each connection, then closes its block", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("session.new_block", () =>
          Effect.succeed({ block_id: blockId, revision: 2 }),
        );
        server.handle("block.close", () => Effect.succeed({ block_id: blockId, revision: 3 }));
        server.serveBytes(blockId, () => echoes);
        const rex = yield* RexSdk;
        const reply = yield* Effect.scoped(
          Effect.gen(function* () {
            const forward = yield* rex.tunnels.forwardLocal({
              sessionId,
              target: { host: "db.internal", port: 5432 },
            });
            expect(forward.address).toMatch(/^127\.0\.0\.1:\d+$/);
            return yield* roundTrip(forward.address, "select 1");
          }),
        );
        expect(reply).toBe("echo:select 1");
        const created = server.requestsFor("session.new_block")[0]?.payload;
        expect(created).toMatchObject({
          flavor: "com.superlogical.tunnel.dial",
          options: { host: "db.internal", port: 5432, client_address: expect.any(String) },
        });
        expect(server.requestsFor("block.close").map((request) => request.payload)).toEqual([
          { session_id: sessionId, block_id: blockId },
        ]);
      }),
    ));

  test("forwardRemote carries connections addressed to this client to the local target", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        const echo = yield* startEchoServer();
        server.handle("session.new_block", () =>
          Effect.succeed({ block_id: blockId, revision: 2 }),
        );
        server.handle("block.close", () => Effect.succeed({ block_id: blockId, revision: 3 }));
        server.handle("com.superlogical.tunnel.info", () =>
          Effect.succeed({ flavor: "listen", address: "127.0.0.1:40123", connections: 0 }),
        );
        let outside = "";
        server.serveBytes(blockId, () => (connection) => {
          connection.onMessage((chunk) => {
            if (chunk.length > 0) outside += text(chunk);
            else connection.close(1000);
          });
          connection.send(bytes("hello"));
          connection.send(empty);
        });
        const rex = yield* RexSdk;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const forward = yield* rex.tunnels.forwardRemote({
              sessionId,
              target: { host: "127.0.0.1", port: echo.port },
            });
            expect(forward.address).toBe("127.0.0.1:40123");
            const request = (client: string, ref: string) => ({
              type: "session_event",
              payload: {
                session_id: sessionId,
                event: {
                  type: "block_event",
                  payload: {
                    block_id: blockId,
                    creator_name: "com.superlogical.tunnel",
                    name: "connection_requested",
                    payload: { ref, peer: "203.0.113.4:51234", client },
                  },
                },
              },
            });
            server.emit(request("client:someone-else", "conn:not-ours"));
            server.emit(request("client:test-1", "conn:ours"));
            yield* Effect.sleep("300 millis");
          }),
        );
        expect(server.bytesStreams().map((stream) => stream.ref)).toEqual(["conn:ours"]);
        expect(outside).toBe("echo:hello");
        expect(server.requestsFor("session.new_block")[0]?.payload).toMatchObject({
          flavor: "com.superlogical.tunnel.listen",
          options: { port: 0, client_target: `127.0.0.1:${echo.port}` },
        });
      }),
    ));

  test("a forward reports stopped with RexBlockClosed when its block closes", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("session.new_block", () =>
          Effect.succeed({ block_id: blockId, revision: 2 }),
        );
        server.handle("block.close", () => Effect.succeed({ block_id: blockId, revision: 3 }));
        const rex = yield* RexSdk;
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            const forward = yield* rex.tunnels.forwardLocal({
              sessionId,
              target: { host: "127.0.0.1", port: 9 },
            });
            server.emit({
              type: "session_event",
              payload: {
                session_id: sessionId,
                event: { type: "block_closed", payload: { block_id: blockId } },
              },
            });
            return yield* Effect.exit(forward.stopped);
          }),
        );
        expect(failureTags(exit)).toEqual(["RexBlockClosed"]);
      }),
    ));
});
