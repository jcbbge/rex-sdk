/**
 * Opt-in contract checks against a real Rex server: `REX_SDK_LIVE=1 vp test run src/rex-live.test.ts`.
 *
 * The suite creates its own session, labelled `rex-sdk-live-…`, and destroys it when it ends.
 * It never reads or changes other sessions. Every result is decoded with the generated codecs,
 * so a server whose answers drift from the snapshot fails here with `RexInvalidResponse`.
 * Set `REX_SDK_LIVE_SERVER` to use a server other than the default personal server.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { Chunk, Effect, Exit, Fiber, Layer, Option, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { REX_API_REVISION, REX_MIN_API_REVISION } from "./rex-config.ts";
import { RexControl } from "./rex-control.ts";
import type { BlockId, SessionId } from "./rex-domain.ts";
import type { RexSessionEvent } from "./rex-events.ts";
import { rexLayout } from "./rex-layout.ts";
import { RexSdk, rexSdkLayerFromOptions, type IRexSdk } from "./rex-sdk.ts";
import { referenceRexTerminalTail } from "./testing/rex-test-terminal.ts";

const live = process.env["REX_SDK_LIVE"] === "1";
/** The file transfer and forward tests share file paths and ports with the server: local only. */
const serverIsLocal = process.env["REX_SDK_LIVE_SERVER"] === undefined;

function runLive<A, E>(
  body: (
    rex: IRexSdk,
    sessionId: SessionId,
    shellBlockId: BlockId,
  ) => Effect.Effect<A, E, RexControl>,
) {
  const layer: Layer.Layer<RexSdk | RexControl, unknown> = rexSdkLayerFromOptions({
    ...(process.env["REX_SDK_LIVE_SERVER"] === undefined
      ? {}
      : { server: process.env["REX_SDK_LIVE_SERVER"] }),
    client: { kind: "agent", name: "rex-sdk-live-test", version: "0.0.0" },
  });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rex = yield* RexSdk;
        const created = yield* Effect.acquireRelease(
          rex.sessions.create({
            label: `rex-sdk-live-${Date.now().toString(36)}`,
            initialWindows: [
              {
                windowLabel: "main",
                layout: rexLayout.terminal({
                  shell: "none",
                  command: ["/bin/sh", "-c", "printf 'rex-sdk-ready\\n'; exec cat"],
                  label: "echo",
                }),
              },
            ],
          }),
          (session) => Effect.ignore(rex.sessions.destroy({ sessionId: session.sessionId })),
        );
        const shellBlockId = created.initialWindows[0]?.blockIds[0];
        if (shellBlockId === undefined)
          return yield* Effect.die("session.create returned no block");
        return yield* body(rex, created.sessionId, shellBlockId);
      }),
    ).pipe(Effect.provide(layer)),
  );
}

const pollUntil = <A, E>(effect: Effect.Effect<A, E>, predicate: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const value = yield* effect;
      if (predicate(value)) return value;
      yield* Effect.sleep("100 millis");
    }
    return yield* Effect.die("condition never held");
  });

describe.runIf(live)("live Rex server", () => {
  test(
    "tunnel blocks start detached and describe what they forward",
    () =>
      runLive((rex, sessionId) =>
        Effect.gen(function* () {
          const dial = yield* rex.tunnels.createDial({
            sessionId,
            label: "live-dial",
            options: { host: "127.0.0.1", port: 9, clientAddress: "127.0.0.1:19" },
          });
          const dialInfo = yield* rex.tunnels.info({ sessionId, blockId: dial.blockId });
          expect([dialInfo.flavor, dialInfo.target, dialInfo.clientAddress]).toEqual([
            "dial",
            Option.some("127.0.0.1:9"),
            Option.some("127.0.0.1:19"),
          ]);
          const listen = yield* rex.tunnels.createListen({
            sessionId,
            options: { address: "127.0.0.1", port: 0 },
          });
          const listenInfo = yield* rex.tunnels.info({ sessionId, blockId: listen.blockId });
          expect(listenInfo.flavor).toBe("listen");
          expect(Option.getOrElse(listenInfo.address, () => "")).toMatch(/^127\.0\.0\.1:\d+$/);
          yield* rex.blocks.close({ sessionId, blockId: dial.blockId });
          yield* rex.blocks.close({ sessionId, blockId: listen.blockId });
        }),
      ),
    30_000,
  );

  test(
    "server, discovery, and listing operations decode",
    () =>
      runLive((rex, sessionId) =>
        Effect.gen(function* () {
          // `server.version` reports the newest revision the server speaks, not the one in use.
          const version = yield* rex.server.version();
          const serverRevision = Option.getOrElse(version.apiRevision, () => 0);
          const { apiRevision } = yield* (yield* RexControl).connection;
          expect(apiRevision).toBeGreaterThanOrEqual(REX_MIN_API_REVISION);
          expect(apiRevision).toBe(Math.min(REX_API_REVISION, serverRevision));
          console.info(`Rex negotiated API revision ${apiRevision}`);
          yield* rex.server.status();
          yield* rex.server.whoami();
          yield* rex.hosts.list();
          const creators = yield* rex.creators.list();
          expect(creators.creators.map((creator) => creator.name)).toContain(
            "com.superlogical.terminal",
          );
          const sessions = yield* rex.sessions.list();
          expect(sessions.sessions.map((session) => session.sessionId)).toContain(sessionId);
          yield* rex.clients.list({});
          yield* rex.sessions.listClients({ sessionId });
          yield* rex.sessions.listBlocks({ sessionId });
          yield* rex.sessions.help({ sessionId });
          const resolved = yield* rex.targets.resolve({ kinds: ["session"], queries: [sessionId] });
          expect(resolved).toBeDefined();
        }),
      ),
    30_000,
  );

  test(
    "terminal operations type, read, and inspect a running program",
    () =>
      runLive((rex, sessionId, blockId) =>
        Effect.gen(function* () {
          const target = { sessionId, blockId };
          yield* pollUntil(rex.terminals.read(target), (screen) =>
            screen.includes("rex-sdk-ready"),
          );
          yield* rex.terminals.writeLine(target, "ping-from-sdk");
          const screen = yield* pollUntil(
            rex.terminals.read(target, { trim: true }),
            (text) => text.split("ping-from-sdk").length >= 3,
          );
          expect(screen).toContain("ping-from-sdk");
          const process = yield* rex.terminals.process(target);
          expect(Option.isNone(process.lastExit)).toBe(true);
          yield* rex.terminals.size(target);
          yield* rex.terminals.title(target);
          yield* rex.terminals.pwd(target);
          yield* rex.terminals.modes(target);
          yield* rex.terminals.inputMode(target);
          yield* rex.terminals.programStatus(target);
          yield* rex.terminals.listDir(target, { path: "/" });
          const ports = yield* rex.terminals.ports(target);
          expect(["ok", "partial", "unsupported"]).toContain(ports.status);
          yield* rex.blocks.describe({ sessionId, blockId });
        }),
      ),
    30_000,
  );

  test(
    "readTail matches the bytes of the output, including a jump that lands inside a character",
    () =>
      runLive((rex, sessionId, blockId) =>
        Effect.gen(function* () {
          // Each line ends in two ✓ (3 bytes each); docs/research/rex-blob-read.md has the probe.
          const script =
            "i=0; while [ $i -lt 3000 ]; do printf 'tail line %d \\342\\234\\223\\342\\234\\223\\n' $i; i=$((i+1)); done; printf 'tail-done\\n'; exec cat";
          const split = yield* rex.blocks.splitBeside({
            sessionId,
            anchorId: blockId,
            placement: "right",
            layout: rexLayout.terminal({
              shell: "none",
              command: ["/bin/sh", "-c", script],
              label: "tail",
            }),
          });
          const tailBlockId = split.blockIds[0];
          if (tailBlockId === undefined) return yield* Effect.die("no block");
          const target = { sessionId, blockId: tailBlockId };
          yield* rex.terminals.waitForOutput(target, /^tail-done$/, { timeout: "10 seconds" });
          const content = yield* rex.terminals.read(target, { trim: true, unwrap: true });
          const bytes = Buffer.from(content);
          const lastCheck = bytes.lastIndexOf("✓");
          // Scrollback keeps only the newest lines, but well over the windows below.
          expect(lastCheck).toBeGreaterThan(30_000);

          // A read that starts inside a character shows the bytes it cut as U+FFFD.
          const first = yield* rex.terminals.format(target, {
            trim: true,
            unwrap: true,
            maxBytes: 1,
          });
          const id = Option.getOrThrow(first.id);
          const cut = yield* rex.terminals.blobRead(target, {
            id,
            offset: lastCheck + 1,
            maxBytes: 4,
          });
          expect(cut.data.startsWith("\uFFFD\uFFFD")).toBe(true);

          // Windows whose jump lands on each byte of the last line's ✓s, and on its start.
          const lastLine = bytes.lastIndexOf("tail line 2999");
          for (const landing of [
            lastLine,
            lastLine + 1,
            lastCheck - 2,
            lastCheck + 1,
            lastCheck + 2,
          ]) {
            const maxBytes = bytes.length - landing - 1;
            const tail = yield* rex.terminals.readTail(target, { maxBytes });
            expect({ landing, tail }).toEqual({
              landing,
              tail: referenceRexTerminalTail(content, maxBytes),
            });
          }
          for (const maxBytes of [1_000, 20_000, bytes.length]) {
            const tail = yield* rex.terminals.readTail(target, { maxBytes });
            expect(tail).toEqual(referenceRexTerminalTail(content, maxBytes));
          }
        }),
      ),
    30_000,
  );

  test(
    "waits match output after a mark, share one data connection, and see quiet",
    () =>
      runLive((rex, sessionId, blockId) =>
        Effect.gen(function* () {
          const target = { sessionId, blockId };
          yield* rex.terminals.waitForOutput(target, /^rex-sdk-ready$/, { timeout: "10 seconds" });
          const mark = yield* rex.terminals.mark(target);
          // Output from before the mark never matches.
          const stale = yield* Effect.exit(
            rex.terminals.waitForOutput(
              target,
              { pattern: "rex-sdk-ready", since: mark },
              { timeout: "500 millis" },
            ),
          );
          expect(Exit.isFailure(stale)).toBe(true);
          // Rex refuses a second data connection per block, so these must share one.
          const [fresh, quiet] = yield* Effect.all(
            [
              rex.terminals.waitForOutput(
                target,
                { pattern: /^fresh-(\d+)$/, since: mark },
                { timeout: "10 seconds" },
              ),
              rex.terminals.waitForQuiet(target, { quietFor: "500 millis", timeout: "10 seconds" }),
              rex.terminals.writeLine(target, "fresh-42"),
            ],
            { concurrency: "unbounded" },
          );
          expect(fresh.groups).toEqual(["42"]);
          expect(fresh.alignment).toEqual(Option.some("offset"));
          expect(quiet).toBeUndefined();
          const tail = yield* rex.terminals.readTail(target, { maxBytes: 4_096 });
          expect(tail.lines).toContain("fresh-42");
        }),
      ),
    30_000,
  );

  test(
    "layout operations split, label, zoom, float, and close blocks and windows",
    () =>
      runLive((rex, sessionId, blockId) =>
        Effect.gen(function* () {
          const split = yield* rex.blocks.splitBeside({
            sessionId,
            anchorId: blockId,
            placement: "right",
            ratio: 0.3,
            layout: rexLayout.terminal({
              shell: "none",
              command: ["/bin/sh", "-c", "exec cat"],
              label: "side",
            }),
          });
          const sideBlockId = split.blockIds[0];
          expect(sideBlockId).toBeDefined();
          if (sideBlockId === undefined) return;
          yield* rex.blocks.setLabel({ sessionId, blockId: sideBlockId, label: "renamed" });
          yield* rex.blocks.zoom({ sessionId, blockId: sideBlockId, zoom: true });
          yield* rex.blocks.zoom({ sessionId, blockId: sideBlockId, zoom: false });
          yield* rex.blocks.swap({ sessionId, blockId, otherBlockId: sideBlockId });
          yield* rex.blocks.focus({ sessionId, blockId: sideBlockId });
          yield* rex.blocks.focus({ sessionId, blockId });
          const reversed = yield* rex.blocks.reverseFocus({ sessionId });
          expect(reversed.reversed).toBe(true);
          expect(reversed.sessionId).toEqual(Option.some(sessionId));
          expect(reversed.blockId).toEqual(Option.some(sideBlockId));

          const window = yield* rex.windows.create({
            sessionId,
            windowLabel: "second",
            focus: false,
            layout: rexLayout.vertical(rexLayout.terminal(), rexLayout.terminal(), 0.6),
          });
          expect(window.blockIds.length).toBe(2);
          yield* rex.windows.setLabel({ sessionId, windowId: window.windowId, label: "renamed" });
          const view = yield* rex.sessions.view({ sessionId });
          expect(view.windows.map((current) => current.label)).toContainEqual(
            Option.some("renamed"),
          );

          const layer = yield* rex.layers.create({
            sessionId,
            windowId: window.windowId,
            bounds: [0.1, 0.1, 0.5, 0.5],
            layout: rexLayout.terminal(),
            focus: false,
          });
          yield* rex.layers.setState({ sessionId, layerId: layer.layerId, state: "minimized" });
          const minimized = yield* rex.sessions.view({ sessionId });
          const layerState = minimized.windows
            .flatMap((current) => current.layers)
            .find((current) => current.layerId === layer.layerId)?.state;
          expect(layerState).toEqual(Option.some("minimized"));
          yield* rex.layers.setState({
            sessionId,
            layerId: layer.layerId,
            state: "normal",
            focus: true,
          });
          yield* rex.layers.close({ sessionId, layerId: layer.layerId });
          yield* rex.windows.close({ sessionId, windowId: window.windowId });
          yield* rex.blocks.close({ sessionId, blockId: sideBlockId });
        }),
      ),
    30_000,
  );

  test(
    "waitForExit reports a program's exit code",
    () =>
      runLive((rex, sessionId, blockId) =>
        Effect.gen(function* () {
          const split = yield* rex.blocks.splitBeside({
            sessionId,
            anchorId: blockId,
            placement: "below",
            // Rex 0.0.1793047680 reports exit code 0 for this program when `shell` is "none",
            // so the command runs through the login shell here.
            layout: rexLayout.terminal({
              command: ["/bin/sh", "-c", "sleep 0.5; exit 3"],
              exit: { onCompletion: false },
            }),
          });
          const exitBlockId = split.blockIds[0];
          if (exitBlockId === undefined) return yield* Effect.die("no block");
          const exit = yield* rex.terminals.waitForExit(
            { sessionId, blockId: exitBlockId },
            { timeout: "10 seconds" },
          );
          expect(exit.exitCode).toBe(3);
        }),
      ),
    30_000,
  );

  test(
    "events and output streams deliver live data",
    () =>
      runLive((rex, sessionId, blockId) =>
        Effect.gen(function* () {
          const target = { sessionId, blockId };
          const items = yield* rex.terminals.stream(target).pipe(
            Stream.takeUntil((item) => item._tag === "Message" && item.message.type === "resize"),
            Stream.runCollect,
            Effect.timeout("10 seconds"),
          );
          expect(
            Chunk.toReadonlyArray(Chunk.fromIterable(items)).some(
              (item) => item._tag === "Message",
            ),
          ).toBe(true);

          const created = yield* Effect.forkChild(
            rex.events.waitFor(
              (event): event is RexSessionEvent =>
                event._tag === "SessionEvent" &&
                event.type === "window_created" &&
                event.sessionId === sessionId,
              { sessionIds: [sessionId], timeout: "10 seconds" },
            ),
          );
          yield* Effect.sleep("200 millis");
          yield* rex.windows.create({
            sessionId,
            windowLabel: "evented",
            focus: false,
            layout: rexLayout.terminal(),
          });
          const event = yield* Fiber.join(created);
          expect(event._tag === "SessionEvent" && event.type).toBe("window_created");

          const views = yield* rex.sessions
            .watchView(sessionId)
            .pipe(Stream.take(1), Stream.runCollect);
          expect(Chunk.fromIterable(views).pipe(Chunk.size)).toBe(1);
        }),
      ),
    30_000,
  );

  test.runIf(serverIsLocal)(
    "downloads and pastes files through rex.data.bytes.v1",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "rex-sdk-live-"));
      const original = new Uint8Array(randomBytes(200_000));
      writeFileSync(join(directory, "source.bin"), original);
      return runLive((rex, sessionId, blockId) =>
        Effect.gen(function* () {
          const target = { sessionId, blockId };
          const contents = yield* rex.terminals.readFile(target, join(directory, "source.bin"));
          expect(Buffer.from(contents.bytes).equals(Buffer.from(original))).toBe(true);
          expect(contents.file.size).toBe(original.length);

          const destination = join(directory, "copy.bin");
          const written = yield* rex.terminals
            .downloadToFile(target, join(directory, "source.bin"), destination)
            .pipe(Effect.provide(NodeFileSystem.layer));
          expect(written._tag).toBe("Downloaded");
          expect(readFileSync(destination).equals(Buffer.from(original))).toBe(true);

          yield* rex.terminals.pasteFiles(target, [
            { name: "pasted.txt", data: "pasted by rex-sdk" },
          ]);
          // The terminal runs `cat`, so the typed path comes back on its screen.
          // A long path wraps on screen, so match it with the lines joined.
          const screen = yield* pollUntil(
            rex.terminals
              .read(target, { trim: true })
              .pipe(Effect.map((text) => text.split("\n").join(""))),
            (text) => text.includes("pasted.txt"),
          );
          const typed = screen
            .match(/(\/\S*?(?:\\ \S*?)*pasted\.txt)/)?.[1]
            ?.replaceAll("\\ ", " ");
          expect(typed).toBeDefined();
          expect(readFileSync(typed ?? "", "utf8")).toBe("pasted by rex-sdk");
        }),
      ).finally(() => rmSync(directory, { recursive: true, force: true }));
    },
    30_000,
  );

  test.runIf(serverIsLocal)(
    "forwards connections both ways through tunnel blocks",
    () =>
      runLive((rex, sessionId) =>
        Effect.gen(function* () {
          const echo = yield* Effect.acquireRelease(
            Effect.callback<{ readonly port: number; readonly close: () => void }>((resume) => {
              const server = createServer({ allowHalfOpen: true }, (socket) => {
                socket.on("data", (data) => socket.write(`echo:${data.toString()}`));
                socket.on("end", () => socket.end());
              });
              server.listen(0, "127.0.0.1", () => {
                const address = server.address();
                resume(
                  Effect.succeed({
                    port: address !== null && typeof address === "object" ? address.port : 0,
                    close: () => server.close(),
                  }),
                );
              });
            }),
            (server) => Effect.sync(server.close),
          );
          const roundTrip = (address: string, message: string) =>
            Effect.callback<string, Error>((resume) => {
              const separator = address.lastIndexOf(":");
              const socket = connect(
                {
                  host: address.slice(0, separator),
                  port: Number(address.slice(separator + 1)),
                  allowHalfOpen: true,
                },
                () => {
                  socket.write(message);
                  socket.end();
                },
              );
              let received = "";
              socket.on("data", (data) => {
                received += data.toString();
              });
              socket.on("end", () => resume(Effect.succeed(received)));
              socket.on("error", (error) => resume(Effect.fail(error)));
            });

          const local = yield* rex.tunnels.forwardLocal({
            sessionId,
            target: { host: "127.0.0.1", port: echo.port },
          });
          expect(yield* roundTrip(local.address, "through -L")).toBe("echo:through -L");

          const remote = yield* rex.tunnels.forwardRemote({
            sessionId,
            target: { host: "127.0.0.1", port: echo.port },
          });
          expect(yield* roundTrip(remote.address, "through -R")).toBe("echo:through -R");
        }).pipe(Effect.scoped),
      ),
    30_000,
  );
});
