import { Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { defaultRexSocketPath, parseRexServerAddress } from "./rex-config.ts";
import { BlockId, SessionId, WindowId } from "./rex-domain.ts";
import { RexLayoutNode, rexLayout } from "./rex-layout.ts";
import { RexClientRequestFailure } from "./client-service.ts";
import { RexSdk } from "./rex-sdk.ts";
import type { RexMethodInput } from "./rex-operation.ts";
import type { RexTerminalStreamItem } from "./rex-terminal-stream.ts";
import type { RexEventStreamOptions } from "./event-service.ts";
import { rexEventSessionId, type RexEvent } from "./rex-events.ts";
import { runRexSdkTest } from "./testing/rex-test-runtime.ts";
import { rexTestServerError, type IRexTestServer } from "./testing/rex-test-server.ts";

const sessionId = SessionId.make("session:01a1aaaa-0000-0000-0000-000000000001");
const otherSessionId = SessionId.make("session:01a1aaaa-0000-0000-0000-000000000002");
const blockId = BlockId.make("block:01a1bbbb-0000-0000-0000-000000000001");
const windowId = WindowId.make("window:01a1cccc-0000-0000-0000-000000000001");
const target = { sessionId, blockId };

const view = (revision: number, id: string = sessionId) => ({
  revision,
  session_id: id,
  windows: [],
});
const attachResult = (id: string = sessionId) => ({
  client_id: "client:test-1",
  view: view(1, id),
});

function handleAttach(server: IRexTestServer) {
  server.handle("session.attach", (payload) =>
    Effect.succeed(
      attachResult(
        Schema.decodeUnknownSync(Schema.Struct({ session_id: Schema.String }))(payload).session_id,
      ),
    ),
  );
}

const failureTags = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag))
    : ["Success"];

const sessionEvent = (id: string, type: string, payload: object) => ({
  type: "session_event",
  payload: { session_id: id, event: { type, payload } },
});

const nameOf = (event: RexEvent) =>
  event._tag === "TerminalEvent" || event._tag === "BlockEvent" ? event.name : event.type;

const terminalEvent = (name: string, payload: object) =>
  sessionEvent(sessionId, "block_event", {
    block_id: blockId,
    creator_name: "com.superlogical.terminal",
    name,
    payload,
  });

describe("automatic attachment", () => {
  test("attaches once per session before session-scoped calls, sharing concurrent attaches", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("session.set_label", () => Effect.succeed({ revision: 2 }));
        const rex = yield* RexSdk;
        yield* Effect.all(
          [
            rex.sessions.setLabel({ sessionId, label: "a" }),
            rex.sessions.setLabel({ sessionId, label: "b" }),
            rex.sessions.setLabel({ sessionId, label: "c" }),
          ],
          { concurrency: "unbounded" },
        );
        yield* rex.sessions.setLabel({ sessionId: otherSessionId, label: "d" });
        expect(server.requestsFor("session.attach").map((request) => request.payload)).toEqual([
          { session_id: sessionId },
          { session_id: otherSessionId },
        ]);
        const methods = server.requests().map((request) => request.method);
        expect(methods.indexOf("session.attach")).toBeLessThan(
          methods.indexOf("session.set_label"),
        );
      }),
    ));

  test("does not attach for methods that work without it", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        server.handle("session.list", () => Effect.succeed({ sessions: [] }));
        server.handle("client.list", () => Effect.succeed({ clients: [] }));
        const rex = yield* RexSdk;
        yield* rex.sessions.list();
        yield* rex.clients.list({ sessionId });
        expect(server.requestsFor("session.attach")).toEqual([]);
      }),
    ));

  test("attaches again on a new connection that did not resume the client", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("session.set_label", () => Effect.succeed({ revision: 2 }));
        const rex = yield* RexSdk;
        yield* rex.sessions.setLabel({ sessionId, label: "a" });
        server.connections()[0]?.terminate();
        yield* Effect.sleep("50 millis");
        yield* rex.sessions.setLabel({ sessionId, label: "b" });
        expect(server.requestsFor("session.attach").map((request) => request.connectionId)).toEqual(
          [1, 2],
        );
      }),
    ));

  test("retries the attach on the next call after an attach fails", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        server.handle("session.attach", () =>
          Effect.succeed(rexTestServerError("session_not_found")),
        );
        server.handle("session.view", () => Effect.succeed(view(1)));
        const rex = yield* RexSdk;
        const first = yield* Effect.exit(rex.sessions.view({ sessionId }));
        expect(failureTags(first)).toEqual(["RexSessionNotFound"]);
        handleAttach(server);
        yield* rex.sessions.view({ sessionId });
        expect(server.requestsFor("session.attach").length).toBe(2);
      }),
    ));

  test("an explicit attach counts, and an explicit detach makes the next call attach again", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("session.detach", () => Effect.succeed({}));
        server.handle("session.view", () => Effect.succeed(view(1)));
        const rex = yield* RexSdk;
        yield* rex.sessions.attach({ sessionId });
        yield* rex.sessions.view({ sessionId });
        expect(server.requestsFor("session.attach").length).toBe(1);
        yield* rex.sessions.detach({ sessionId });
        yield* rex.sessions.view({ sessionId });
        expect(server.requestsFor("session.attach").length).toBe(2);
      }),
    ));
});

describe("input validation", () => {
  test("rejects invalid arguments without sending anything", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const rex = yield* RexSdk;
        const exit = yield* Effect.exit(rex.terminals.resize(target, { columns: -1, rows: 24 }));
        expect(failureTags(exit)).toEqual(["RexInvalidInput"]);
        const layout = yield* Effect.exit(
          rex.blocks.split({
            sessionId,
            direction: "horizontal",
            side: "after",
            layout: rexLayout.horizontal(rexLayout.terminal(), rexLayout.terminal(), 1.5),
          }),
        );
        expect(failureTags(layout)).toEqual(["RexInvalidInput"]);
        expect(server.requests()).toEqual([]);
      }),
    ));

  test("splitBeside maps CLI placements and the new blocks' share onto direction, side, and ratio", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("session.new_split", () =>
          Effect.succeed({
            anchor_id: blockId,
            block_ids: ["block:new"],
            split_ids: ["split:new"],
            revision: 2,
          }),
        );
        const rex = yield* RexSdk;
        yield* rex.blocks.splitBeside({
          sessionId,
          anchorId: blockId,
          placement: "right",
          ratio: 0.3,
        });
        yield* rex.blocks.splitBeside({
          sessionId,
          windowId,
          placement: "above",
          ratio: 0.25,
          layout: rexLayout.terminal({ command: ["top"], label: "Monitor" }),
          focus: true,
        });
        expect(server.requestsFor("session.new_split").map((request) => request.payload)).toEqual([
          {
            session_id: sessionId,
            anchor_id: blockId,
            direction: "horizontal",
            side: "after",
            layout: { block: { flavor: "com.superlogical.terminal.shell" } },
            ratio: 0.7,
          },
          {
            session_id: sessionId,
            window_id: windowId,
            direction: "vertical",
            side: "before",
            layout: {
              block: {
                flavor: "com.superlogical.terminal.shell",
                label: "Monitor",
                options: { command: ["top"] },
              },
            },
            ratio: 0.25,
            focus: true,
          },
        ]);
      }),
    ));
});

describe("events", () => {
  test("decodes server, session, terminal, other block, and unknown events", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        server.handle("session.attach_all", () => Effect.succeed({ sessions: [] }));
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(rex.events.stream(), 5)),
        );
        yield* Effect.sleep("100 millis");
        server.emit({
          type: "session_created",
          payload: { session: { session_id: sessionId, label: "work" } },
        });
        server.emit(
          sessionEvent(sessionId, "window_created", { window_id: windowId, label: "Tab" }),
        );
        server.emit(terminalEvent("child_exited", { exit_code: 2, error: "exit status 2" }));
        server.emit(
          sessionEvent(sessionId, "block_event", {
            block_id: blockId,
            creator_name: "com.example.viewer",
            name: "opened",
            payload: { file: "a.png" },
          }),
        );
        server.emit({ type: "brand_new_event", payload: { x: 1 } });
        const events = yield* Fiber.join(fiber);
        expect(events.map((event) => event._tag)).toEqual([
          "ServerEvent",
          "SessionEvent",
          "TerminalEvent",
          "BlockEvent",
          "UnknownEvent",
        ]);
        const [created, window, exited] = events;
        expect(
          created?._tag === "ServerEvent" &&
            created.type === "session_created" &&
            created.payload.session.label,
        ).toBe("work");
        expect(
          window?._tag === "SessionEvent" &&
            window.type === "window_created" &&
            window.payload.windowId,
        ).toBe(windowId);
        expect(
          exited?._tag === "TerminalEvent" &&
            exited.name === "child_exited" && [exited.payload.exitCode, exited.payload.error],
        ).toEqual([2, Option.some("exit status 2")]);
        expect(server.requestsFor("session.attach_all").map((request) => request.payload)).toEqual([
          { event_scope: "all" },
        ]);
      }),
    ));

  test("a session stream attaches to its sessions only after subscribing", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        server.handle("session.attach", () =>
          Effect.sync(() => {
            server.emit(
              sessionEvent(sessionId, "session_label_changed", { label: "during attach" }),
            );
            return attachResult();
          }),
        );
        const rex = yield* RexSdk;
        const first = yield* Stream.runHead(rex.events.stream({ sessionIds: [sessionId] }));
        expect(Option.map(first, (event) => event._tag === "SessionEvent" && event.type)).toEqual(
          Option.some("session_label_changed"),
        );
        expect(server.requestsFor("session.attach_all")).toEqual([]);
      }),
    ));

  test("decodes prompt requests, prompt ends, and dropped events", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        server.handle("session.attach_all", () => Effect.succeed({ sessions: [] }));
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(rex.events.stream(), 3)),
        );
        yield* Effect.sleep("100 millis");
        server.emit({
          type: "client_prompt_requested",
          payload: {
            call_id: "call-1",
            action: "git.stage",
            prompt: {
              kind: "pick",
              title: "Files",
              multiple: true,
              items: [{ id: "a", title: "a.ts", selected: true }],
            },
            timeout_ms: 60_000,
          },
        });
        server.emit({
          type: "client_prompt_ended",
          payload: { call_id: "call-1", reason: "answered" },
        });
        server.emit({
          type: "event_dropped",
          payload: { event_type: "block_event", session_id: sessionId, size: 2_000_000 },
        });
        const [requested, ended, dropped] = yield* Fiber.join(fiber);
        expect(
          requested?._tag === "ServerEvent" &&
            requested.type === "client_prompt_requested" && [
              requested.payload.callId,
              requested.payload.prompt.items.map((item) => item.id),
              requested.payload.timeoutMs,
            ],
        ).toEqual(["call-1", ["a"], 60_000]);
        expect(
          ended?._tag === "ServerEvent" && ended.type === "client_prompt_ended" && ended.payload,
        ).toEqual({ callId: "call-1", reason: "answered" });
        expect(
          dropped?._tag === "ServerEvent" &&
            dropped.type === "event_dropped" && [
              dropped.payload.eventType,
              dropped.payload.sessionId,
              dropped.payload.blockId,
            ],
        ).toEqual(["block_event", Option.some(sessionId), Option.none()]);
      }),
    ));

  test("subscribers on one connection receive only the sessions and server events they selected", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("session.attach_all", () => Effect.succeed({ sessions: [] }));
        const rex = yield* RexSdk;
        const describeEvent = (event: RexEvent) =>
          `${Option.getOrElse(rexEventSessionId(event), () => "server")} ${nameOf(event)}`;
        const collect = (count: number, options?: RexEventStreamOptions) =>
          Effect.forkChild(
            Stream.runCollect(Stream.take(rex.events.stream(options), count)).pipe(
              Effect.map((events) => events.map(describeEvent)),
            ),
          );
        const streamA = yield* collect(2, { sessionIds: [sessionId] });
        const waitForA = yield* Effect.forkChild(
          rex.events.waitFor((event): event is RexEvent => nameOf(event) === "window_closed", {
            sessionIds: [sessionId],
          }),
        );
        const streamB = yield* collect(2, { sessionIds: [otherSessionId] });
        const sessionScope = yield* collect(4, { server: "session" });
        const everything = yield* collect(5);
        // Every subscription exists once its attach reached the server, since streams subscribe first.
        yield* Effect.sleep("100 millis");
        expect(server.requestsFor("session.attach").map((request) => request.payload)).toEqual([
          { session_id: sessionId },
          { session_id: otherSessionId },
        ]);
        expect(server.requestsFor("session.attach_all").length).toBe(2);

        server.emit(sessionEvent(otherSessionId, "window_closed", { window_id: windowId }));
        server.emit(sessionEvent(sessionId, "window_closed", { window_id: windowId }));
        server.emit(terminalEvent("child_exited", { exit_code: 0 }));
        server.emit({
          type: "session_created",
          payload: { session: { session_id: otherSessionId, label: "b" } },
        });
        server.emit(sessionEvent(otherSessionId, "session_label_changed", { label: "b" }));

        const a = `${sessionId}`;
        const b = `${otherSessionId}`;
        const waited = yield* Fiber.join(waitForA);
        expect(describeEvent(waited)).toBe(`${a} window_closed`);
        expect(yield* Fiber.join(streamA)).toEqual([`${a} window_closed`, `${a} child_exited`]);
        expect(yield* Fiber.join(streamB)).toEqual([
          `${b} window_closed`,
          `${b} session_label_changed`,
        ]);
        expect(yield* Fiber.join(sessionScope)).toEqual([
          `${b} window_closed`,
          `${a} window_closed`,
          "server session_created",
          `${b} session_label_changed`,
        ]);
        expect(yield* Fiber.join(everything)).toEqual([
          `${b} window_closed`,
          `${a} window_closed`,
          `${a} child_exited`,
          "server session_created",
          `${b} session_label_changed`,
        ]);
      }),
    ));

  test("a session-only subscriber does not see server-wide events, dropped ones included", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(
          Stream.runCollect(Stream.take(rex.events.stream({ sessionIds: [sessionId] }), 2)),
        );
        yield* Effect.sleep("100 millis");
        server.emit({ type: "hosts_changed", payload: { hash: "h" } });
        server.emit({ type: "event_dropped", payload: { event_type: "hosts_changed", size: 9 } });
        server.emit({
          type: "event_dropped",
          payload: { event_type: "block_event", session_id: otherSessionId, size: 9 },
        });
        server.emit({
          type: "event_dropped",
          payload: { event_type: "block_event", session_id: sessionId, size: 9 },
        });
        server.emit({ type: "session_destroyed", payload: { session_id: sessionId } });
        const events = yield* Fiber.join(fiber);
        expect(events.map((event) => event._tag === "ServerEvent" && event.type)).toEqual([
          "event_dropped",
          "session_destroyed",
        ]);
      }),
    ));

  test("waitFor returns the first matching event and times out otherwise", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(
          rex.events.waitFor(
            (event) => event._tag === "SessionEvent" && event.type === "window_closed",
            { sessionIds: [sessionId] },
          ),
        );
        yield* Effect.sleep("100 millis");
        server.emit(
          sessionEvent(sessionId, "window_created", { window_id: windowId, label: "Tab" }),
        );
        server.emit(sessionEvent(sessionId, "window_closed", { window_id: windowId }));
        const event = yield* Fiber.join(fiber);
        expect(event._tag === "SessionEvent" && event.type).toBe("window_closed");
        const timeout = yield* Effect.exit(
          rex.events.waitFor((event) => event._tag === "UnknownEvent", {
            sessionIds: [sessionId],
            timeout: "50 millis",
          }),
        );
        expect(failureTags(timeout)).toEqual(["RexRequestTimeout"]);
      }),
    ));

  test("watchView emits the view, then only newer views, and ends when the session is destroyed", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        let revision = 5;
        server.handle("session.view", () => Effect.sync(() => view(revision)));
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(Stream.runCollect(rex.sessions.watchView(sessionId)));
        yield* Effect.sleep("100 millis");
        server.emit(sessionEvent(sessionId, "session_view_changed", { revision: 4 }));
        server.emit(sessionEvent(otherSessionId, "session_view_changed", { revision: 9 }));
        revision = 7;
        server.emit(sessionEvent(sessionId, "session_view_changed", { revision: 7 }));
        yield* Effect.sleep("100 millis");
        server.emit({ type: "session_destroyed", payload: { session_id: sessionId } });
        const views = yield* Fiber.join(fiber);
        expect(views.map((current) => current.revision)).toEqual([5, 7]);
        expect(server.requestsFor("session.view").length).toBe(2);
      }),
    ));

  test("watchView reads the view again after a dropped event about its session", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        let revision = 5;
        server.handle("session.view", () => Effect.sync(() => view(revision)));
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(Stream.runCollect(rex.sessions.watchView(sessionId)));
        yield* Effect.sleep("100 millis");
        revision = 8;
        server.emit({
          type: "event_dropped",
          payload: { event_type: "hosts_changed", size: 9 },
        });
        server.emit({
          type: "event_dropped",
          payload: { event_type: "session_view_changed", session_id: sessionId, size: 2_000_000 },
        });
        yield* Effect.sleep("100 millis");
        server.emit({ type: "session_destroyed", payload: { session_id: sessionId } });
        const views = yield* Fiber.join(fiber);
        expect(views.map((current) => current.revision)).toEqual([5, 8]);
        // The first read, then one reread: a server-wide drop names no session.
        expect(server.requestsFor("session.view").length).toBe(2);
      }),
    ));
});

describe("terminals", () => {
  test("read joins every part of a long result", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("com.superlogical.terminal.format", () =>
          Effect.succeed({ content: "héllo ", id: 9, total: 17, eof: false }),
        );
        const parts = ["wor", "ld ✓"];
        server.handle("com.superlogical.terminal.blob_read", () =>
          Effect.sync(() => {
            const data = parts.shift() ?? "";
            return { id: 9, data, total: 17, eof: parts.length === 0 };
          }),
        );
        const rex = yield* RexSdk;
        expect(yield* rex.terminals.read(target, { trim: true })).toBe("héllo world ✓");
        expect(server.requestsFor("com.superlogical.terminal.format")[0]?.payload).toEqual({
          session_id: sessionId,
          block_id: blockId,
          args: { trim: true, max_bytes: 524_288 },
        });
        expect(
          server
            .requestsFor("com.superlogical.terminal.blob_read")
            .map((request) => request.payload),
        ).toEqual([
          {
            session_id: sessionId,
            block_id: blockId,
            args: { id: 9, offset: 7, max_bytes: 524_288 },
          },
          {
            session_id: sessionId,
            block_id: blockId,
            args: { id: 9, offset: 10, max_bytes: 524_288 },
          },
        ]);
      }),
    ));

  test("writeLine types the text and presses Return", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("com.superlogical.terminal.write", () =>
          Effect.succeed({ bytes_written: 8 }),
        );
        const rex = yield* RexSdk;
        yield* rex.terminals.writeLine(target, "npm test");
        expect(server.requestsFor("com.superlogical.terminal.write")[0]?.payload).toEqual({
          session_id: sessionId,
          block_id: blockId,
          args: { data: "npm test\r" },
        });
      }),
    ));

  test("waitForExit returns at once when the program already exited", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("com.superlogical.terminal.process", () =>
          Effect.succeed({ last_exit: { exit_code: 0 } }),
        );
        const rex = yield* RexSdk;
        expect(yield* rex.terminals.waitForExit(target)).toEqual({
          exitCode: 0,
          error: Option.none(),
        });
      }),
    ));

  test("waitForExit reads the exit again after a dropped event about its block", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        let exited = false;
        server.handle("com.superlogical.terminal.process", () =>
          Effect.sync(() => ({
            last_exit: exited ? { exit_code: 4, error: "exit status 4" } : null,
          })),
        );
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(rex.terminals.waitForExit(target));
        yield* Effect.sleep("100 millis");
        server.emit({
          type: "event_dropped",
          payload: { event_type: "block_event", session_id: otherSessionId, size: 9 },
        });
        exited = true;
        server.emit({
          type: "event_dropped",
          payload: {
            event_type: "block_event",
            session_id: sessionId,
            block_id: blockId,
            creator_name: "com.superlogical.terminal",
            block_event_name: "child_exited",
            size: 2_000_000,
          },
        });
        expect(yield* Fiber.join(fiber)).toEqual({
          exitCode: 4,
          error: Option.some("exit status 4"),
        });
        // The first check, then one recheck: the other session's drop is ignored.
        expect(server.requestsFor("com.superlogical.terminal.process").length).toBe(2);
      }),
    ));

  test("waitForExit fails with RexBlockClosed when a dropped block_closed hid the close", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        let closed = false;
        server.handle("com.superlogical.terminal.process", () =>
          closed
            ? Effect.succeed(rexTestServerError("not_found", "block not found"))
            : Effect.succeed({ last_exit: null }),
        );
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(Effect.exit(rex.terminals.waitForExit(target)));
        yield* Effect.sleep("100 millis");
        closed = true;
        server.emit({
          type: "event_dropped",
          payload: { event_type: "block_closed", session_id: sessionId, size: 2_000_000 },
        });
        expect(failureTags(yield* Fiber.join(fiber))).toEqual(["RexBlockClosed"]);
      }),
    ));

  test("waitForExit waits for the exit event, and fails when the block closes first", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("com.superlogical.terminal.process", () =>
          Effect.succeed({ last_exit: null }),
        );
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(rex.terminals.waitForExit(target));
        yield* Effect.sleep("100 millis");
        server.emit(terminalEvent("child_exited", { exit_code: 3, error: "exit status 3" }));
        expect(yield* Fiber.join(fiber)).toEqual({
          exitCode: 3,
          error: Option.some("exit status 3"),
        });

        const closed = yield* Effect.forkChild(Effect.exit(rex.terminals.waitForExit(target)));
        yield* Effect.sleep("100 millis");
        server.emit(sessionEvent(sessionId, "block_closed", { block_id: blockId }));
        expect(failureTags(yield* Fiber.join(closed))).toEqual(["RexBlockClosed"]);

        const timeout = yield* Effect.exit(
          rex.terminals.waitForExit(target, { timeout: "50 millis" }),
        );
        expect(failureTags(timeout)).toEqual(["RexRequestTimeout"]);
      }),
    ));
});

const encoder = new TextEncoder();
const NONCE = 77n;
const rexMessage = (json: object) =>
  encoder.encode(`\u001b_rex1;${NONCE};${JSON.stringify(json)}\u001b\\`);

function renderItems(items: ReadonlyArray<RexTerminalStreamItem>) {
  const decoder = new TextDecoder();
  return items.map((item) =>
    item._tag === "Output" ? decoder.decode(item.bytes) : item.message.type,
  );
}

describe("data tickets", () => {
  test("bootstrap never requests or returns data tickets, even for a widened input", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        server.handle("session.bootstrap", () =>
          Effect.succeed({
            client_id: "client:test-1",
            server_status: {
              pid: 4242,
              instance_id: "7d7e9aca-9a92-41b1-b849-418e76d8f84b",
              host_id: "0e9d6c1f-4a3b-4a52-9c85-2f6d3f6f2f10",
              started_at: "2026-10-17T09:00:00Z",
              exit_empty: false,
              session_count: 1,
              config: { generation: 1, hash: "a3f1" },
            },
            attach_all: { sessions: [{ session_id: sessionId, label: "work" }] },
            selected_session: null,
            data_tickets: [
              {
                session_id: sessionId,
                block_id: blockId,
                data_ref_id: "terminal",
                ticket: "AAAAAAAAAAAAAAAAAAAAAA",
                expires_in_ms: 30_000,
              },
            ],
          }),
        );
        const rex = yield* RexSdk;
        // A caller holding the full wire input type still can't ask for tickets.
        const widened: RexMethodInput<"session.bootstrap"> = {
          eventScope: "session",
          dataTickets: [{ creatorName: "com.superlogical.terminal", dataRefId: "terminal" }],
        };
        const result = yield* rex.sessions.bootstrap(widened);
        expect(Object.hasOwn(result, "dataTickets")).toBe(false);
        expect(server.requestsFor("session.bootstrap").map((request) => request.payload)).toEqual([
          { event_scope: "session" },
        ]);
      }),
    ));
});

describe("tunnels", () => {
  test("createDial and createListen create detached tunnel blocks with encoded options", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.handle("session.new_block", () =>
          Effect.succeed({ block_id: blockId, revision: 2 }),
        );
        const rex = yield* RexSdk;
        const dial = yield* rex.tunnels.createDial({
          sessionId,
          label: "db",
          options: { host: "127.0.0.1", port: 5432, clientAddress: "127.0.0.1:15432" },
        });
        expect(dial.blockId).toBe(blockId);
        yield* rex.tunnels.createListen({
          sessionId,
          options: { port: 0, clientTarget: "web:80" },
        });
        expect(server.requestsFor("session.new_block").map((request) => request.payload)).toEqual([
          {
            session_id: sessionId,
            flavor: "com.superlogical.tunnel.dial",
            options: { host: "127.0.0.1", port: 5432, client_address: "127.0.0.1:15432" },
            label: "db",
          },
          {
            session_id: sessionId,
            flavor: "com.superlogical.tunnel.listen",
            options: { port: 0, client_target: "web:80" },
          },
        ]);
      }),
    ));

  test("rejects tunnel options outside the flavor's schema without sending anything", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        const rex = yield* RexSdk;
        const exit = yield* Effect.exit(
          rex.tunnels.createDial({ sessionId, options: { host: "db", port: 70_000 } }),
        );
        expect(failureTags(exit)).toEqual(["RexInvalidInput"]);
        expect(server.requests()).toEqual([]);
      }),
    ));
});

describe("terminal output streams", () => {
  test("streams output and Rex messages, then fails with RexBlockClosed when the block closes", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.serveData({
          ...target,
          nonce: NONCE,
          chunks: [
            encoder.encode("snapshot|"),
            rexMessage({ type: "resize", cols: 80, rows: 24 }),
            encoder.encode("$ ls"),
          ],
          closeWith: { code: 4000, reason: "block closed" },
        });
        const rex = yield* RexSdk;
        const items: Array<RexTerminalStreamItem> = [];
        const exit = yield* Effect.exit(
          Stream.runForEach(rex.terminals.stream(target), (item) =>
            Effect.sync(() => items.push(item)),
          ),
        );
        expect(renderItems(items).join("")).toBe("snapshot|resize$ ls");
        expect(failureTags(exit)).toEqual(["RexBlockClosed"]);
        const hello = server.dataHandshakes()[0];
        expect(hello?.[0]).toBe(0x01);
        expect(hello?.length).toBe(17);
        expect(server.requestsFor("data.connect")[0]?.payload).toEqual({
          session_id: sessionId,
          block_id: blockId,
          data_ref_id: "terminal",
          subprotocol: "rex.data.terminal.v1",
        });
      }),
    ));

  test("ends normally when the server ends the stream with status 1000", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.serveData({
          ...target,
          nonce: NONCE,
          chunks: [encoder.encode("done")],
          closeWith: { code: 1000, reason: "" },
        });
        const rex = yield* RexSdk;
        const items = yield* Stream.runCollect(rex.terminals.stream(target));
        expect(renderItems(items)).toEqual(["done"]);
      }),
    ));

  test("fails with RexDataRejected and its reason when the server refuses the HELLO", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.serveData({ ...target, nonce: NONCE, chunks: [], rejectWith: 0x02 });
        const rex = yield* RexSdk;
        const exit = yield* Effect.exit(Stream.runDrain(rex.terminals.stream(target)));
        expect(failureTags(exit)).toEqual(["RexDataRejected"]);
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons[0];
          expect(
            reason?._tag === "Fail" &&
              reason.error._tag === "RexDataRejected" &&
              reason.error.reason,
          ).toBe("already_connected");
        }
      }),
    ));

  test("resumes after a dropped connection without losing or repeating output", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        handleAttach(server);
        server.serveData({ ...target, nonce: NONCE, chunks: [encoder.encode("one|")] });
        const rex = yield* RexSdk;
        const items: Array<RexTerminalStreamItem> = [];
        const fiber = yield* Effect.forkChild(
          Stream.runForEach(rex.terminals.stream(target), (item) =>
            Effect.sync(() => items.push(item)),
          ),
        );
        yield* Effect.sleep("100 millis");
        server.sendData(blockId, encoder.encode("two|"));
        yield* Effect.sleep("50 millis");
        server.terminateData(blockId);
        server.sendData(blockId, encoder.encode("three|"));
        yield* Effect.sleep("200 millis");
        server.closeData(blockId, 1000, "");
        yield* Fiber.join(fiber);
        expect(renderItems(items).join("")).toBe("one|two|three|");
        const resume = server.dataHandshakes()[1];
        expect(resume?.[0]).toBe(0x02);
        expect(resume === undefined ? -1 : Buffer.from(resume).readBigUInt64LE(17)).toBe(8n);
      }),
    ));
});

describe("client requests", () => {
  test("answers perform requests with the handler's result or its failure", () =>
    runRexSdkTest((server) =>
      Effect.gen(function* () {
        server.handle("client.reply", () => Effect.succeed({}));
        const rex = yield* RexSdk;
        const fiber = yield* Effect.forkChild(
          rex.clients.servePerformRequests((request) =>
            request.action === "greet"
              ? Effect.succeed({ hello: "world" })
              : Effect.fail(new RexClientRequestFailure({ code: "refused", message: "not here" })),
          ),
        );
        yield* Effect.sleep("100 millis");
        const requester = {
          client_id: "client:other",
          principal: { kind: "peer", transport: "unix", display: "uid 501" },
        };
        server.emit({
          type: "client_perform_requested",
          payload: { call_id: "c1", action: "greet", requester },
        });
        server.emit({
          type: "client_perform_requested",
          payload: { call_id: "c2", action: "nope", requester },
        });
        yield* Effect.sleep("200 millis");
        yield* Fiber.interrupt(fiber);
        expect(
          server
            .requestsFor("client.reply")
            .map((request) => request.payload)
            .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        ).toEqual([
          { call_id: "c1", result: { hello: "world" } },
          { call_id: "c2", error: { code: "refused", message: "not here" } },
        ]);
      }),
    ));
});

describe("configuration", () => {
  test("finds each platform's default personal-server socket", () => {
    const base = {
      homeDirectory: "/home/me",
      xdgRuntimeDir: Option.none<string>(),
      xdgStateHome: Option.none<string>(),
    };
    expect(defaultRexSocketPath({ ...base, platform: "darwin", homeDirectory: "/Users/me" })).toBe(
      "/Users/me/Library/Application Support/rex/server.sock",
    );
    expect(
      defaultRexSocketPath({
        ...base,
        platform: "linux",
        xdgRuntimeDir: Option.some("/run/user/1000"),
      }),
    ).toBe("/run/user/1000/rex/server.sock");
    expect(defaultRexSocketPath({ ...base, platform: "linux" })).toBe(
      "/home/me/.local/state/rex/run/server.sock",
    );
    expect(
      defaultRexSocketPath({ ...base, platform: "freebsd", xdgStateHome: Option.some("/state") }),
    ).toBe("/state/rex/run/server.sock");
  });

  test("parses the server addresses rex -S accepts and refuses host labels", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* parseRexServerAddress(
            "unix:///Users/me/Library/Application%20Support/rex/server.sock",
          ),
        ).toEqual({
          _tag: "Socket",
          path: "/Users/me/Library/Application Support/rex/server.sock",
        });
        expect(yield* parseRexServerAddress("/run/rex/server.sock")).toEqual({
          _tag: "Socket",
          path: "/run/rex/server.sock",
        });
        expect(yield* parseRexServerAddress("studio.tail1234.ts.net:7297")).toEqual({
          _tag: "Url",
          baseUrl: "ws://studio.tail1234.ts.net:7297",
        });
        expect(yield* parseRexServerAddress("https://rex.tail1234.ts.net")).toEqual({
          _tag: "Url",
          baseUrl: "wss://rex.tail1234.ts.net",
        });
        const label = yield* Effect.exit(parseRexServerAddress("studio"));
        expect(failureTags(label)).toEqual(["RexConfigurationError"]);
      }),
    ));
});

describe("layout schema", () => {
  test("decodes a layout given as data into the tree the builders make", () => {
    const decoded = Schema.decodeUnknownSync(RexLayoutNode)({
      _tag: "Split",
      direction: "horizontal",
      before: { _tag: "Terminal", label: "Code", options: { cwd: "/src", command: ["vim"] } },
      after: { _tag: "Block", flavor: "com.example.notes" },
      ratio: 0.6,
    });
    expect(decoded).toEqual(
      rexLayout.horizontal(
        { _tag: "Terminal", label: "Code", options: { cwd: "/src", command: ["vim"] } },
        rexLayout.block("com.example.notes"),
        0.6,
      ),
    );
    expect(() => Schema.decodeUnknownSync(RexLayoutNode)({ _tag: "Split" })).toThrow();
  });
});
