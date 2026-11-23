/**
 * Calls every SDK operation against the test server, with the server's documented examples.
 *
 * For each method, the test server answers with the method's documented response example (or a
 * fixture validated against the output schema), and the SDK is called with the documented
 * request example decoded into the SDK's camelCase form. The test checks that the request on
 * the wire equals the documented example exactly, that both directions satisfy the server's
 * JSON Schemas, and that the SDK decodes the result. The table of operations doubles as the
 * parity ledger: it must name every server method and block method.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, test } from "vite-plus/test";
import {
  rexBlockMethods,
  rexWireMethods,
  type RexBlockMethod,
  type RexWireMethod,
} from "./generated/rex-wire-schemas.ts";
import { BlockId, SessionId } from "./rex-domain.ts";
import { rexLayout, type RexLayoutNode } from "./rex-layout.ts";
import type { RexBlockMethodArgs, RexMethodInput } from "./rex-operation.ts";
import { RexSdk, type IRexSdk } from "./rex-sdk.ts";
import { rexBlockMethodExamples } from "./testing/rex-block-method-examples.ts";
import { runRexSdkTest } from "./testing/rex-test-runtime.ts";

const RexApiExamples = Schema.Struct({
  methods: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      request_example: Schema.optionalKey(Schema.String),
      response_example: Schema.optionalKey(Schema.String),
    }),
  ),
});
const apiExamples = Schema.decodeUnknownSync(Schema.fromJsonString(RexApiExamples))(
  readFileSync(join(import.meta.dirname, "../schema/rex-api.json"), "utf8"),
);
const exampleFor = new Map(apiExamples.methods.map((method) => [method.name, method]));

function concrete(example: string): Schema.Json {
  return Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(
    example.replaceAll("<uuid>", "01234567-89ab-cdef-0123-456789abcdef"),
  );
}

const LayoutWire: Schema.Codec<LayoutWire> = Schema.Union([
  Schema.Struct({
    block: Schema.Struct({
      flavor: Schema.String,
      label: Schema.optionalKey(Schema.String),
      options: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    }),
  }),
  Schema.Struct({
    split: Schema.Struct({
      direction: Schema.Literals(["horizontal", "vertical"]),
      before: Schema.suspend((): Schema.Codec<LayoutWire> => LayoutWire),
      after: Schema.suspend((): Schema.Codec<LayoutWire> => LayoutWire),
      ratio: Schema.optionalKey(Schema.Number),
    }),
  }),
]);
type LayoutWire =
  | {
      readonly block: {
        readonly flavor: string;
        readonly label?: string;
        readonly options?: { readonly [key: string]: Schema.Json };
      };
    }
  | {
      readonly split: {
        readonly direction: "horizontal" | "vertical";
        readonly before: LayoutWire;
        readonly after: LayoutWire;
        readonly ratio?: number;
      };
    };

/** Rebuilds a documented wire layout with the SDK's layout builders. */
function layoutFromWire(value: Schema.Json | undefined): RexLayoutNode {
  const wire = Schema.decodeUnknownSync(LayoutWire)(value);
  if ("block" in wire) {
    return rexLayout.block(wire.block.flavor, {
      ...(wire.block.label === undefined ? {} : { label: wire.block.label }),
      ...(wire.block.options === undefined ? {} : { options: wire.block.options }),
    });
  }
  const { direction, before, after, ratio } = wire.split;
  return direction === "horizontal"
    ? rexLayout.horizontal(layoutFromWire(before), layoutFromWire(after), ratio)
    : rexLayout.vertical(layoutFromWire(before), layoutFromWire(after), ratio);
}

interface SweepEntry {
  readonly method: string;
  /** The request payload the SDK must send. */
  readonly expectedRequest: Schema.Json | undefined;
  /** Scripted result; validated against the output schema by the test server. */
  readonly result: Schema.Json;
  readonly run: (sdk: IRexSdk) => Effect.Effect<unknown, unknown>;
}

function sweepMethod<Method extends RexWireMethod>(
  method: Method,
  invoke: (
    sdk: IRexSdk,
    input: RexMethodInput<Method>,
    wire: Schema.Json,
  ) => Effect.Effect<unknown, unknown>,
  fixtures: { readonly request?: Schema.Json; readonly result?: Schema.Json } = {},
): SweepEntry {
  const example = exampleFor.get(method);
  const request =
    fixtures.request ??
    (example?.request_example === undefined ? {} : concrete(example.request_example));
  const result =
    fixtures.result ??
    (example?.response_example === undefined ? {} : concrete(example.response_example));
  const codec: Schema.Codec<RexMethodInput<Method>, Schema.Json> = rexWireMethods[method].input;
  return {
    method,
    expectedRequest: request,
    result,
    run: (sdk) =>
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(codec)(request);
        return yield* invoke(sdk, input, request);
      }),
  };
}

const target = {
  sessionId: SessionId.make("session:01234567-89ab-cdef-0123-456789abcdef"),
  blockId: BlockId.make("block:01234567-89ab-cdef-0123-456789abcdef"),
};

function sweepBlockMethod<Method extends RexBlockMethod>(
  method: Method,
  invoke: (sdk: IRexSdk, args: RexBlockMethodArgs<Method>) => Effect.Effect<unknown, unknown>,
  args: Schema.Json,
  result: Schema.Json,
): SweepEntry {
  const codec: Schema.Codec<RexBlockMethodArgs<Method>, Schema.Json> = rexBlockMethods[method].args;
  return {
    method,
    expectedRequest: { session_id: target.sessionId, block_id: target.blockId, args },
    result,
    run: (sdk) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(codec)(args);
        return yield* invoke(sdk, decoded);
      }),
  };
}

const sweep: ReadonlyArray<SweepEntry> = [
  // server
  sweepMethod("server.status", (sdk) => sdk.server.status()),
  sweepMethod("server.version", (sdk) => sdk.server.version()),
  sweepMethod("server.whoami", (sdk) => sdk.server.whoami()),
  sweepMethod("server.config_reload", (sdk) => sdk.server.reloadConfig()),
  sweepMethod("server.stop", (sdk, input) => sdk.server.stop(input)),
  sweepMethod("help.all", (sdk) => sdk.server.help()),
  sweepMethod("server.tailscale.enable", (sdk, input) => sdk.server.tailscale.enable(input)),
  sweepMethod("server.tailscale.disable", (sdk) => sdk.server.tailscale.disable()),
  sweepMethod("server.tailscale.login", (sdk) => sdk.server.tailscale.login()),
  sweepMethod("server.tailscale.logout", (sdk) => sdk.server.tailscale.logout()),
  sweepMethod("server.tailscale.rename", (sdk, input) => sdk.server.tailscale.rename(input)),
  sweepMethod("server.apple.grant_file_access", (sdk, input) =>
    sdk.server.apple.grantFileAccess(input),
  ),
  sweepMethod("server.apple.privacy_status", (sdk) => sdk.server.apple.privacyStatus()),
  // sessions
  sweepMethod("session.list", (sdk) => sdk.sessions.list()),
  sweepMethod("session.create", (sdk, input, wire) =>
    sdk.sessions.create({
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.initialWindows === undefined
        ? {}
        : {
            initialWindows: input.initialWindows.map((window, index) => ({
              ...(window.windowLabel === undefined ? {} : { windowLabel: window.windowLabel }),
              ...(window.layout === undefined
                ? {}
                : { layout: layoutFromWire(initialWindowLayout(wire, index)) }),
            })),
          }),
    }),
  ),
  sweepMethod("session.destroy", (sdk, input) => sdk.sessions.destroy(input)),
  sweepMethod("session.view", (sdk, input) => sdk.sessions.view(input)),
  sweepMethod("session.attach", (sdk, input) => sdk.sessions.attach(input)),
  sweepMethod("session.detach", (sdk, input) => sdk.sessions.detach(input)),
  sweepMethod("session.attach_all", (sdk, input) => sdk.sessions.attachAll(input)),
  sweepMethod("session.bootstrap", (sdk, input) => sdk.sessions.bootstrap(input)),
  sweepMethod("session.set_label", (sdk, input) => sdk.sessions.setLabel(input)),
  sweepMethod("session.move", (sdk, input) => sdk.sessions.move(input)),
  sweepMethod("session.list_blocks", (sdk, input) => sdk.sessions.listBlocks(input)),
  sweepMethod("session.list_clients", (sdk, input) => sdk.sessions.listClients(input)),
  sweepMethod("session.help", (sdk, input) => sdk.sessions.help(input)),
  // windows
  sweepMethod("session.new_window", (sdk, input, wire) => {
    const { layout, ...rest } = input;
    return sdk.windows.create({
      ...rest,
      ...(layout === undefined ? {} : { layout: layoutFromWire(fieldOf(wire, "layout")) }),
    });
  }),
  sweepMethod("session.close_window", (sdk, input) => sdk.windows.close(input)),
  sweepMethod("session.focus_window", (sdk, input) => sdk.windows.focus(input)),
  sweepMethod("session.focus_next_window", (sdk, input) => sdk.windows.focusNext(input)),
  sweepMethod("session.focus_previous_window", (sdk, input) => sdk.windows.focusPrevious(input)),
  sweepMethod("session.move_window", (sdk, input) => sdk.windows.move(input)),
  sweepMethod("session.set_window_label", (sdk, input) => sdk.windows.setLabel(input)),
  // blocks
  sweepMethod("session.new_split", (sdk, input, wire) =>
    sdk.blocks.split({ ...input, layout: layoutFromWire(fieldOf(wire, "layout")) }),
  ),
  sweepMethod("session.new_block", (sdk, input) => sdk.blocks.create(input)),
  sweepMethod("session.move_block", (sdk, input) => sdk.blocks.move(input)),
  sweepMethod("session.swap_blocks", (sdk, input) => sdk.blocks.swap(input)),
  sweepMethod("session.zoom_block", (sdk, input) => sdk.blocks.zoom(input)),
  sweepMethod("session.detach_block", (sdk, input) => sdk.blocks.detach(input)),
  sweepMethod("session.float_block", (sdk, input) => sdk.blocks.float(input)),
  sweepMethod("session.focus_block", (sdk, input) => sdk.blocks.focus(input)),
  sweepMethod("session.focus_direction", (sdk, input) => sdk.blocks.focusDirection(input)),
  sweepMethod("session.focus_next_pane", (sdk, input) => sdk.blocks.focusNext(input)),
  sweepMethod("session.focus_previous_pane", (sdk, input) => sdk.blocks.focusPrevious(input)),
  sweepMethod("focus_history.reverse", (sdk, input) => sdk.blocks.reverseFocus(input), {
    request: { session_id: target.sessionId, cursor: 5 },
    result: { reversed: true, cursor: 4, session_id: target.sessionId, block_id: target.blockId },
  }),
  sweepMethod("session.resize_pane", (sdk, input) => sdk.blocks.resize(input)),
  sweepMethod("session.set_block_label", (sdk, input) => sdk.blocks.setLabel(input)),
  sweepMethod("session.own_block", (sdk, input) => sdk.blocks.own(input)),
  sweepMethod("session.disown_block", (sdk, input) => sdk.blocks.disown(input)),
  sweepMethod("session.describe_block", (sdk, input) => sdk.blocks.describe(input)),
  sweepMethod("block.close", (sdk, input) => sdk.blocks.close(input)),
  sweepMethod("block.event", (sdk, input) => sdk.blocks.sendEvent(input)),
  sweepMethod("block.method", (sdk, input) => sdk.blocks.callMethod(input), {
    result: { generation: 1 },
  }),
  // layers
  sweepMethod("session.new_layer", (sdk, input, wire) =>
    sdk.layers.create({ ...input, layout: layoutFromWire(fieldOf(wire, "layout")) }),
  ),
  sweepMethod("session.close_layer", (sdk, input) => sdk.layers.close(input)),
  sweepMethod("session.raise_layer", (sdk, input) => sdk.layers.raise(input)),
  sweepMethod("session.lower_layer", (sdk, input) => sdk.layers.lower(input)),
  sweepMethod("session.resize_layer", (sdk, input) => sdk.layers.resize(input)),
  sweepMethod("session.set_layer_state", (sdk, input) => sdk.layers.setState(input)),
  // clients
  sweepMethod("client.list", (sdk, input) => sdk.clients.list(input)),
  sweepMethod("client.inspect", (sdk, input) => sdk.clients.inspect(input)),
  sweepMethod("client.set_label", (sdk, input) => sdk.clients.setLabel(input)),
  sweepMethod("client.set_script", (sdk, input) => sdk.clients.setScript(input)),
  sweepMethod("client.keymap", (sdk, input) => sdk.clients.keymap(input)),
  sweepMethod("client.action", (sdk, input) => sdk.clients.action(input)),
  sweepMethod("client.key", (sdk, input) => sdk.clients.key(input)),
  sweepMethod("client.perform", (sdk, input) => sdk.clients.perform(input)),
  sweepMethod("client.reply", (sdk, input) => sdk.clients.reply(input)),
  // targets, hosts, creators
  sweepMethod("target.resolve", (sdk, input) => sdk.targets.resolve(input)),
  sweepMethod("target.complete", (sdk, input) => sdk.targets.complete(input)),
  sweepMethod("hosts.list", (sdk) => sdk.hosts.list()),
  sweepMethod("hosts.put", (sdk, input) => sdk.hosts.put(input)),
  sweepMethod("hosts.remove", (sdk, input) => sdk.hosts.remove(input)),
  sweepMethod("block_creator.list", (sdk) => sdk.creators.list()),
  // data connections: the documented ticket is not a live ticket, so the server rejects the HELLO.
  sweepMethod("data.connect", (sdk, input) =>
    sdk.terminals.stream({ sessionId: input.sessionId, blockId: input.blockId }).pipe(
      Stream.runDrain,
      Effect.catchTag("RexDataRejected", () => Effect.void),
    ),
  ),
  // terminal block methods
  sweepBlockMethod(
    "com.superlogical.terminal.write",
    (sdk, args) => sdk.terminals.write(target, args),
    rexBlockMethodExamples["com.superlogical.terminal.write"].args,
    rexBlockMethodExamples["com.superlogical.terminal.write"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.format",
    (sdk, args) => sdk.terminals.format(target, args),
    rexBlockMethodExamples["com.superlogical.terminal.format"].args,
    rexBlockMethodExamples["com.superlogical.terminal.format"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.blob_read",
    (sdk, args) => sdk.terminals.blobRead(target, args),
    rexBlockMethodExamples["com.superlogical.terminal.blob_read"].args,
    rexBlockMethodExamples["com.superlogical.terminal.blob_read"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.clear",
    (sdk) => sdk.terminals.clear(target),
    rexBlockMethodExamples["com.superlogical.terminal.clear"].args,
    rexBlockMethodExamples["com.superlogical.terminal.clear"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.reset",
    (sdk) => sdk.terminals.reset(target),
    rexBlockMethodExamples["com.superlogical.terminal.reset"].args,
    rexBlockMethodExamples["com.superlogical.terminal.reset"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.resize",
    (sdk, args) => sdk.terminals.resize(target, args),
    rexBlockMethodExamples["com.superlogical.terminal.resize"].args,
    rexBlockMethodExamples["com.superlogical.terminal.resize"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.size",
    (sdk) => sdk.terminals.size(target),
    rexBlockMethodExamples["com.superlogical.terminal.size"].args,
    rexBlockMethodExamples["com.superlogical.terminal.size"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.set_theme",
    (sdk, args) => sdk.terminals.setTheme(target, args),
    rexBlockMethodExamples["com.superlogical.terminal.set_theme"].args,
    rexBlockMethodExamples["com.superlogical.terminal.set_theme"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.title",
    (sdk) => sdk.terminals.title(target),
    rexBlockMethodExamples["com.superlogical.terminal.title"].args,
    rexBlockMethodExamples["com.superlogical.terminal.title"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.pwd",
    (sdk) => sdk.terminals.pwd(target),
    rexBlockMethodExamples["com.superlogical.terminal.pwd"].args,
    rexBlockMethodExamples["com.superlogical.terminal.pwd"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.process",
    (sdk) => sdk.terminals.process(target),
    rexBlockMethodExamples["com.superlogical.terminal.process"].args,
    rexBlockMethodExamples["com.superlogical.terminal.process"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.modes",
    (sdk) => sdk.terminals.modes(target),
    rexBlockMethodExamples["com.superlogical.terminal.modes"].args,
    rexBlockMethodExamples["com.superlogical.terminal.modes"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.input_mode",
    (sdk) => sdk.terminals.inputMode(target),
    rexBlockMethodExamples["com.superlogical.terminal.input_mode"].args,
    rexBlockMethodExamples["com.superlogical.terminal.input_mode"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.list_dir",
    (sdk, args) => sdk.terminals.listDir(target, args),
    rexBlockMethodExamples["com.superlogical.terminal.list_dir"].args,
    rexBlockMethodExamples["com.superlogical.terminal.list_dir"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.clipboard_read",
    (sdk, args) => sdk.terminals.clipboardRead(target, args),
    rexBlockMethodExamples["com.superlogical.terminal.clipboard_read"].args,
    rexBlockMethodExamples["com.superlogical.terminal.clipboard_read"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.program_status",
    (sdk) => sdk.terminals.programStatus(target),
    rexBlockMethodExamples["com.superlogical.terminal.program_status"].args,
    rexBlockMethodExamples["com.superlogical.terminal.program_status"].result,
  ),
  sweepBlockMethod(
    "com.superlogical.terminal.ports",
    (sdk) => sdk.terminals.ports(target),
    rexBlockMethodExamples["com.superlogical.terminal.ports"].args,
    rexBlockMethodExamples["com.superlogical.terminal.ports"].result,
  ),
  // file transfers: the SDK picks the ref, so the sweep matches its form rather than its value.
  {
    ...sweepBlockMethod(
      "com.superlogical.terminal.download_begin",
      (sdk, args) =>
        Effect.scoped(
          sdk.terminals.download(
            target,
            args.path,
            args.ifNoneMatch === undefined ? {} : { ifNoneMatch: args.ifNoneMatch },
          ),
        ),
      rexBlockMethodExamples["com.superlogical.terminal.download_begin"].args,
      rexBlockMethodExamples["com.superlogical.terminal.download_begin"].result,
    ),
    expectedRequest: {
      session_id: target.sessionId,
      block_id: target.blockId,
      args: {
        ref: expect.stringMatching(/^download:[0-9a-f-]{36}$/),
        path: "report.csv",
        if_none_match: "v1",
      },
    },
  },
  // The scripted ticket is not a live ticket, so the server rejects the HELLO.
  {
    ...sweepBlockMethod(
      "com.superlogical.terminal.upload_begin",
      (sdk, args) =>
        sdk.terminals
          .pasteFiles(target, [{ name: args.name, data: "hello" }])
          .pipe(Effect.catchTag("RexDataRejected", () => Effect.void)),
      rexBlockMethodExamples["com.superlogical.terminal.upload_begin"].args,
      rexBlockMethodExamples["com.superlogical.terminal.upload_begin"].result,
    ),
    expectedRequest: {
      session_id: target.sessionId,
      block_id: target.blockId,
      args: { ref: expect.stringMatching(/^upload:[0-9a-f-]{36}$/), name: "notes.txt", size: 5 },
    },
  },
  // tunnel block methods
  sweepBlockMethod(
    "com.superlogical.tunnel.info",
    (sdk) => sdk.tunnels.info(target),
    rexBlockMethodExamples["com.superlogical.tunnel.info"].args,
    rexBlockMethodExamples["com.superlogical.tunnel.info"].result,
  ),
];

/** Block methods reached only through `blocks.callMethod`, because no namespace owns them. */
const reachedThroughCallMethod: ReadonlySet<string> = new Set([
  "com.superlogical.onboarding.set_step",
  "com.superlogical.onboarding.state",
]);

const decodeJsonObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

function fieldOf(value: Schema.Json, key: string): Schema.Json | undefined {
  const object = decodeJsonObject(value);
  return object._tag === "Some" ? object.value[key] : undefined;
}

function initialWindowLayout(wire: Schema.Json, index: number): Schema.Json | undefined {
  const windows = fieldOf(wire, "initial_windows");
  return Array.isArray(windows) ? fieldOf(windows[index] ?? null, "layout") : undefined;
}

describe("contract sweep", () => {
  test("names every server method and block method exactly once", () => {
    const covered = sweep.map((entry) => entry.method);
    expect(new Set(covered).size).toBe(covered.length);
    expect(covered.toSorted()).toEqual(
      [...Object.keys(rexWireMethods), ...Object.keys(rexBlockMethods)]
        .filter((method) => !reachedThroughCallMethod.has(method))
        .toSorted(),
    );
  });

  for (const entry of sweep) {
    test(`${entry.method} sends the documented request and decodes the documented result`, () =>
      runRexSdkTest((server) =>
        Effect.gen(function* () {
          for (const other of sweep)
            server.handle(other.method, () => Effect.succeed(other.result));
          server.handle("session.attach", () => Effect.succeed(attachResult));
          if (entry.method === "data.connect")
            server.serveData({ ...target, chunks: [], nonce: 1n });
          const sdk = yield* RexSdk;
          yield* entry.run(sdk);
          const sent = server.requestsFor(entry.method);
          expect(sent.length).toBe(1);
          expect(sent[0]?.payload ?? {}).toEqual(entry.expectedRequest);
        }),
      ));
  }
});

const attachResult = {
  client_id: "client:01234567-89ab-cdef-0123-456789abcdef",
  view: { revision: 1, session_id: "session:01234567-89ab-cdef-0123-456789abcdef", windows: [] },
};
