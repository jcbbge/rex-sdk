import { Effect, Exit, Fiber, Layer, Queue } from "effect";
import { describe, expect, test } from "vite-plus/test";
import { rexConfigLayerFromOptions, type RexConfigOptions } from "./rex-config.ts";
import { RexControl, rexControlLayerWithoutDependencies } from "./rex-control.ts";
import {
  rexTestServerError,
  startRexTestServer,
  type IRexTestServer,
  type RexTestServerOptions,
} from "./testing/rex-test-server.ts";

function runControlTest<A, E>(
  body: (server: IRexTestServer) => Effect.Effect<A, E, RexControl>,
  serverOptions: RexTestServerOptions = {},
  configOptions: Omit<RexConfigOptions, "server"> = {},
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* startRexTestServer(serverOptions);
        const layer = rexControlLayerWithoutDependencies.pipe(
          Layer.provide(
            rexConfigLayerFromOptions({
              server: server.socketPath,
              client: { kind: "agent", name: "rex-sdk-test", version: "0.0.0" },
              ...configOptions,
            }),
          ),
        );
        const result = yield* body(server).pipe(Effect.provide(layer));
        expect(server.violations()).toEqual([]);
        return result;
      }),
    ),
  );
}

const versionResult = (rexVersion: string) => ({
  rex_version: rexVersion,
  platform: "darwin_arm64",
  commit: "0000000",
  built_at: "2026-10-26T20:48:00Z",
  dirty: false,
  api_revision: 18,
});

const exitTag = <A, E extends { readonly _tag: string }>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.map((reason) => (reason._tag === "Fail" ? reason.error._tag : reason._tag))
    : ["Success"];

describe("RexControl", () => {
  test("offers revision 19 with a minimum of 18 and the configured identity", () =>
    runControlTest((server) =>
      Effect.gen(function* () {
        const control = yield* RexControl;
        const info = yield* control.connection;
        expect(info.apiRevision).toBe(18);
        expect(info.generation).toBe(1);
        expect(
          String(info.clientId.pipe((option) => (option._tag === "Some" ? option.value : ""))),
        ).toBe("client:test-1");
        expect(server.connections()[0]?.hello).toEqual({
          type: "hello",
          api_revision: 19,
          api_min_revision: 18,
          client: { kind: "agent", name: "rex-sdk-test", version: "0.0.0" },
        });
      }),
    ));

  test("opens the connection lazily and shares it across requests", () =>
    runControlTest((server) =>
      Effect.gen(function* () {
        const control = yield* RexControl;
        expect(server.connectionCount()).toBe(0);
        server.handle("server.version", () => Effect.succeed(versionResult("1")));
        yield* Effect.all(
          [control.request("server.version", {}), control.request("server.version", {})],
          {
            concurrency: "unbounded",
          },
        );
        expect(server.connectionCount()).toBe(1);
      }),
    ));

  test("matches responses that arrive out of order to their requests", () =>
    runControlTest((server) =>
      Effect.gen(function* () {
        const control = yield* RexControl;
        server.handle("session.list", (payload) =>
          Effect.succeed({ sessions: [] }).pipe(
            Effect.delay(payload === undefined ? "50 millis" : "1 millis"),
          ),
        );
        server.handle("server.whoami", () =>
          Effect.succeed({
            principal: { kind: "peer", transport: "unix", display: "uid 1" },
            account: "slow",
          }).pipe(Effect.delay("80 millis")),
        );
        server.handle("server.version", () => Effect.succeed(versionResult("fast")));
        const [whoami, version] = yield* Effect.all(
          [control.request("server.whoami", {}), control.request("server.version", {})],
          { concurrency: "unbounded" },
        );
        expect(whoami.payload).toMatchObject({ account: "slow" });
        expect(version.payload).toMatchObject({ rex_version: "fast" });
      }),
    ));

  test("fails with the tagged error for a documented server error code", () =>
    runControlTest((server) =>
      Effect.gen(function* () {
        const control = yield* RexControl;
        server.handle("session.view", () =>
          Effect.succeed(rexTestServerError("session_not_found", "no such session")),
        );
        const exit = yield* Effect.exit(
          control.request("session.view", { session_id: "session:x" }),
        );
        expect(exitTag(exit)).toEqual(["RexSessionNotFound"]);
        const unknown = yield* Effect.exit(control.request("nope.method", {}));
        expect(exitTag(unknown)).toEqual(["RexMethodNotFound"]);
      }),
    ));

  test("gives up after the request timeout and ignores the late response", () =>
    runControlTest(
      (server) =>
        Effect.gen(function* () {
          const control = yield* RexControl;
          server.handle("server.version", () =>
            Effect.succeed(versionResult("late")).pipe(Effect.delay("300 millis")),
          );
          const exit = yield* Effect.exit(control.request("server.version", {}));
          expect(exitTag(exit)).toEqual(["RexRequestTimeout"]);
          yield* Effect.sleep("400 millis");
          server.handle("server.version", () => Effect.succeed(versionResult("next")));
          const next = yield* control.request("server.version", {});
          expect(next.payload).toMatchObject({ rex_version: "next" });
        }),
      {},
      { requestTimeout: "100 millis" },
    ));

  test("fails in-flight requests as lost when the connection drops, then reconnects with the token", () =>
    runControlTest((server) =>
      Effect.gen(function* () {
        const control = yield* RexControl;
        server.handle("server.version", () => Effect.never);
        const fiber = yield* Effect.forkChild(Effect.exit(control.request("server.version", {})));
        yield* Effect.sleep("50 millis");
        server.connections()[0]?.terminate();
        const exit = yield* Fiber.join(fiber);
        expect(exitTag(exit)).toEqual(["RexConnectionLost"]);

        server.handle("server.version", () => Effect.succeed(versionResult("again")));
        const again = yield* control.request("server.version", {});
        expect(again.payload).toMatchObject({ rex_version: "again" });
        expect(server.connectionCount()).toBe(2);
        expect(server.connections()[0]?.hello).toMatchObject({ reconnect_token: "token-1" });
        const info = yield* control.connection;
        expect(info.generation).toBe(2);
      }),
    ));

  test.each([19, 20])("uses a negotiated revision of %s", (apiRevision) =>
    runControlTest(
      () =>
        Effect.gen(function* () {
          const control = yield* RexControl;
          const info = yield* control.connection;
          expect(info.apiRevision).toBe(apiRevision);
        }),
      { apiRevision },
    ),
  );

  test("rejects a negotiated revision below the minimum", () =>
    runControlTest(
      () =>
        Effect.gen(function* () {
          const control = yield* RexControl;
          const exit = yield* Effect.exit(control.connection);
          expect(exitTag(exit)).toEqual(["RexUnsupportedApiRevision"]);
        }),
      { apiRevision: 17 },
    ));

  test("reports the server's no-common-revision close as an unsupported revision", () =>
    runControlTest(
      () =>
        Effect.gen(function* () {
          const control = yield* RexControl;
          const exit = yield* Effect.exit(control.request("server.version", {}));
          expect(exitTag(exit)).toEqual(["RexUnsupportedApiRevision"]);
        }),
      { closeAfterHello: { code: 1008, reason: "no common API revision: update the server" } },
    ));

  test("refuses to send a request larger than the connection's limit", () =>
    runControlTest(
      (server) =>
        Effect.gen(function* () {
          const control = yield* RexControl;
          const exit = yield* Effect.exit(
            control.request("session.set_label", {
              session_id: "session:x",
              label: "x".repeat(70_000),
            }),
          );
          expect(exitTag(exit)).toEqual(["RexMessageTooLarge"]);
          expect(server.requests()).toEqual([]);
        }),
      { maxMessageBytes: 65_536 },
    ));

  test("delivers events in seq order to every subscriber", () =>
    runControlTest((server) =>
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* RexControl;
          const first = yield* control.subscribe;
          const second = yield* control.subscribe;
          yield* control.connection;
          server.emit({
            type: "session_created",
            payload: { session: { session_id: "session:a", label: "a" } },
          });
          server.emit({ type: "session_destroyed", payload: { session_id: "session:a" } });
          const fromFirst = yield* Queue.takeN(first, 2);
          const fromSecond = yield* Queue.takeN(second, 2);
          expect(fromFirst.map((event) => [event.seq, event.type])).toEqual([
            [1, "session_created"],
            [2, "session_destroyed"],
          ]);
          expect(fromSecond.map((event) => event.seq)).toEqual([1, 2]);
        }),
      ),
    ));

  test("skips message types it doesn't know", () =>
    runControlTest((server) =>
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* RexControl;
          const events = yield* control.subscribe;
          yield* control.connection;
          server.connections()[0]?.sendRaw(JSON.stringify({ type: "future_message", hello: true }));
          server.emit({ type: "hosts_changed", payload: { hash: "h" } });
          const event = yield* Queue.take(events);
          expect(event.type).toBe("hosts_changed");
        }),
      ),
    ));

  test("fails subscribers when an event seq is skipped", () =>
    runControlTest((server) =>
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* RexControl;
          const events = yield* control.subscribe;
          yield* control.connection;
          server.connections()[0]?.sendRaw(
            JSON.stringify({
              type: "event",
              seq: 5,
              payload: { type: "hosts_changed", payload: { hash: "h" } },
            }),
          );
          const exit = yield* Effect.exit(Queue.take(events));
          expect(exitTag(exit)).toEqual(["RexEventsLost"]);
        }),
      ),
    ));

  test("fails a subscriber that falls too far behind instead of skipping events", () =>
    runControlTest((server) =>
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* RexControl;
          const events = yield* control.subscribe;
          yield* control.connection;
          for (let index = 0; index < 4200; index += 1)
            server.emit({ type: "hosts_changed", payload: { hash: `${index}` } });
          yield* Effect.sleep("200 millis");
          const drained = yield* Effect.exit(
            Queue.takeAll(events).pipe(Effect.andThen(Queue.take(events))),
          );
          expect(exitTag(drained)).toEqual(["RexEventsLost"]);
        }),
      ),
    ));

  test("fails subscribers when the connection ends", () =>
    runControlTest((server) =>
      Effect.scoped(
        Effect.gen(function* () {
          const control = yield* RexControl;
          const events = yield* control.subscribe;
          yield* control.connection;
          server.connections()[0]?.close(1001, "keepalive timeout");
          const exit = yield* Effect.exit(Queue.take(events));
          expect(exitTag(exit)).toEqual(["RexEventsLost"]);
        }),
      ),
    ));

  test("rejects malformed control messages by ending the connection", () =>
    runControlTest((server) =>
      Effect.gen(function* () {
        const control = yield* RexControl;
        server.handle("server.version", () => Effect.never);
        const fiber = yield* Effect.forkChild(Effect.exit(control.request("server.version", {})));
        yield* Effect.sleep("50 millis");
        server.connections()[0]?.sendRaw("{not json");
        const exit = yield* Fiber.join(fiber);
        expect(exitTag(exit)).toEqual(["RexConnectionLost"]);
      }),
    ));
});
