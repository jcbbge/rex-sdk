/**
 * Calls every Rex codemode tool the way pi does (validate against the tool's parameter schema,
 * then execute) against the SDK's test server, never a live Rex server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Ajv2020 } from "ajv/dist/2020.js";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import type { TSchema } from "typebox";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  BlockId,
  RexSdk,
  SessionId,
  rexBlockMethods,
  rexSdkLayerFromOptions,
  rexWireMethods,
} from "../../src/index.ts";
import { rexBlockMethodExamples } from "../../src/testing/rex-block-method-examples.ts";
import { startRexTestTerminal } from "../../src/testing/rex-test-terminal.ts";
import {
  rexTestServerError,
  startRexTestServer,
  type IRexTestServer,
  type RexTestServerBytesPeer,
} from "../../src/testing/rex-test-server.ts";
import {
  registerRexCodemodeTools,
  rexHereFromEnv,
  rexToolNamespace,
  shouldRegisterRexTools,
  type RexCodemodeTool,
} from "../index.ts";
import { isForkDeniedRexTool, rexToolOperations } from "../fork-policy.ts";
import {
  rexToolExclusions,
  rexToolOperations as upstreamOperations,
} from "../rex-tool-operations.ts";
import { RexToolError, type RexToolRuntime } from "../rex-tool-runtime.ts";
import { encodeRexToolResult } from "../rex-tool-schemas.ts";
import { REX_SEARCH_DEFAULT_LIMIT, REX_SEARCH_TOOL_NAME } from "../rex-tool-search.ts";

const uuid = "01234567-89ab-cdef-0123-456789abcdef";
const sessionId = SessionId.make(`session:${uuid}`);
const blockId = BlockId.make(`block:${uuid}`);
const here = { sessionId, blockId };
/** A terminal whose program already exited, and a shell for the mark flow. */
const exitedBlockId = BlockId.make("block:01234567-89ab-cdef-0123-000000000002");
const shellBlockId = BlockId.make("block:01234567-89ab-cdef-0123-000000000003");

// ---------------------------------------------------------------------------------------------
// JSON helpers that keep tests free of type assertions.

const Json = Schema.Json;
const decodeJsonText = Schema.decodeUnknownSync(Schema.fromJsonString(Json));
const decodeJsonObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Json));

function fieldOf(value: unknown, ...path: ReadonlyArray<string | number>): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  return current;
}

function arrayOf(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function objectOf(value: unknown): { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : {};
}

// ---------------------------------------------------------------------------------------------
// Fixtures: documented examples for server methods, shared examples for block methods.

const ApiExamples = Schema.Struct({
  methods: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      request_example: Schema.optionalKey(Schema.String),
      response_example: Schema.optionalKey(Schema.String),
    }),
  ),
});
const apiExamples = Schema.decodeUnknownSync(Schema.fromJsonString(ApiExamples))(
  readFileSync(join(import.meta.dirname, "../../schema/rex-api.json"), "utf8"),
);
const concrete = (example: string | undefined) =>
  example === undefined ? {} : decodeJsonText(example.replaceAll("<uuid>", uuid));
const exampleFor = new Map(apiExamples.methods.map((method) => [method.name, method]));

const isWireMethod = (name: string): name is keyof typeof rexWireMethods => name in rexWireMethods;
const isBlockMethod = (name: string): name is keyof typeof rexBlockMethods =>
  name in rexBlockMethods;

/** Tool arguments for a tool that calls one documented method, from the method's example. */
function argumentsFromExample(method: string): { readonly [key: string]: unknown } {
  if (isWireMethod(method)) {
    const decode = Schema.decodeUnknownSync(rexWireMethods[method].input);
    return objectOf(encodeRexToolResult(decode(concrete(exampleFor.get(method)?.request_example))));
  }
  if (isBlockMethod(method)) {
    const decode = Schema.decodeUnknownSync(rexBlockMethods[method].args);
    const args = fieldOf(rexBlockMethodExamples, method, "args") ?? {};
    return { ...here, ...objectOf(encodeRexToolResult(decode(args))) };
  }
  throw new Error(`no example for ${method}`);
}

const terminal = { _tag: "Terminal", label: "Code", options: { cwd: "/tmp", command: ["ls"] } };
const layout = { _tag: "Split", direction: "horizontal", before: terminal, after: terminal };

/** Arguments for tools that do more than pass one documented example through. */
const customArguments: { readonly [tool: string]: { readonly [key: string]: unknown } } = {
  rex_search: { query: "terminal" },
  rex_terminals_writeLine: { ...here, text: "ls" },
  rex_terminals_waitForOutput: {
    ...here,
    match: { type: "regex", value: "\\bls$" },
    timeoutMs: 2_000,
  },
  rex_terminals_waitForExit: { sessionId, blockId: exitedBlockId, timeoutMs: 2_000 },
  rex_terminals_waitForQuiet: { ...here, quietForMs: 50, timeoutMs: 2_000 },
  rex_terminals_mark: here,
  rex_terminals_readTail: { ...here, maxBytes: 4_096 },
  rex_terminals_read: { ...here, trim: true, unwrap: true },
  rex_terminals_readFile: { ...here, path: "report.csv" },
  rex_terminals_pasteFiles: { ...here, files: [{ name: "notes.txt", text: "hello" }] },
  rex_sessions_create: { label: "fixture", initialWindows: [{ windowLabel: "Code", layout }] },
  rex_tunnels_createDial: { sessionId, options: { host: "127.0.0.1", port: 5432 } },
  rex_tunnels_createListen: { sessionId, label: "web", options: { port: 0 } },
  rex_events_waitFor: { type: "session_destroyed", sessionId, timeoutMs: 2_000 },
};

function argumentsFor(toolName: string): { readonly [key: string]: unknown } {
  const custom = customArguments[toolName];
  if (custom !== undefined) return custom;
  const operation = rexToolOperations.find((candidate) => `rex_${candidate.name}` === toolName);
  if (operation?.method === undefined) throw new Error(`no arguments for ${toolName}`);
  return argumentsFromExample(operation.method);
}

/** Server and block methods no tool reaches. */
const unreachedMethods = new Set([
  "session.detach",
  "session.attach_all",
  "session.bootstrap",
  "focus_history.reverse",
  "session.new_layer",
  "session.new_split",
  "session.new_window",
  ...upstreamOperations
    .filter(isForkDeniedRexTool)
    .flatMap(({ method }) => (method === undefined ? [] : [method])),
  "com.superlogical.onboarding.set_step",
  "com.superlogical.onboarding.state",
]);

const file = {
  path: "/srv/app/report.csv",
  name: "report.csv",
  size: 11,
  modified_at: "2026-11-23T06:36:08Z",
  version: "v1",
};
const refOf = (payload: unknown) => {
  const ref = fieldOf(payload, "args", "ref");
  return typeof ref === "string" ? ref : "";
};
const sendsFile: RexTestServerBytesPeer = (connection) => {
  connection.send(new TextEncoder().encode("hello world"));
  connection.send(new Uint8Array(0));
  connection.close(1000);
};
const acceptsUpload: RexTestServerBytesPeer = (connection) =>
  connection.onMessage((chunk) => {
    if (chunk.length === 0) connection.close(1000);
  });

/** Answers every method with a result valid for its output schema. */
function handleEverything(server: IRexTestServer) {
  for (const method of Object.keys(rexWireMethods)) {
    // The test server issues live tickets for data.connect; the documented one is not live.
    if (method === "data.connect") continue;
    const example = exampleFor.get(method)?.response_example;
    server.handle(method, () => Effect.succeed(concrete(example)));
  }
  server.handle("block.method", () => Effect.succeed({ generation: 1 }));
  server.handle("session.attach", () =>
    Effect.succeed({
      client_id: `client:${uuid}`,
      view: { revision: 1, session_id: sessionId, windows: [] },
    }),
  );
  for (const [method, example] of Object.entries(rexBlockMethodExamples)) {
    server.handle(method, () => Effect.succeed(example.result));
  }
  // Terminal methods go to scripted terminals, which keep text, stream, and exit consistent.
  startRexTestTerminal(server, here, { content: "$ ls" });
  startRexTestTerminal(
    server,
    { sessionId, blockId: exitedBlockId },
    { content: "done", exitedWith: 0 },
  );
  server.handle("com.superlogical.terminal.download_begin", (payload) =>
    Effect.sync(() => ({
      ...file,
      ticket: server.issueBytesTicket(refOf(payload), sendsFile),
      expires_in_ms: 60_000,
    })),
  );
  server.handle("com.superlogical.terminal.upload_begin", (payload) =>
    Effect.sync(() => ({
      ticket: server.issueBytesTicket(refOf(payload), acceptsUpload),
      expires_in_ms: 60_000,
    })),
  );
}

// ---------------------------------------------------------------------------------------------
// Registration and calls, as pi makes them.

interface Registered {
  readonly tools: ReadonlyMap<string, RexCodemodeTool>;
  readonly registered: ReadonlyArray<ToolDefinition<TSchema, undefined>>;
  readonly shutdown: Array<() => unknown>;
  readonly runtime: RexToolRuntime;
}

function register(socketPath: string): Registered {
  const registered: Array<ToolDefinition<TSchema, undefined>> = [];
  const shutdown: Array<() => unknown> = [];
  const { tools, runtime } = registerRexCodemodeTools(
    {
      registerTool: (tool) => {
        registered.push(tool);
      },
      on: (_event, handler) => shutdown.push(handler),
    },
    {
      here: { sessionId, blockId },
      makeLayer: () =>
        rexSdkLayerFromOptions({
          server: socketPath,
          client: { kind: "agent", name: "rex-codemode-test", version: "0.0.0" },
          requestTimeout: "2 seconds",
        }),
    },
  );
  return { tools, registered, shutdown, runtime };
}

/** Validates like pi does for a model or script call, then executes. */
async function callTool(
  tools: ReadonlyMap<string, RexCodemodeTool>,
  name: string,
  args: { readonly [key: string]: unknown },
  signal?: AbortSignal,
) {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`tool ${name} is not registered`);
  const validated: unknown = validateToolArguments(tool.definition, {
    type: "toolCall",
    id: "call-1",
    name,
    arguments: decodeJsonObject(args),
  });
  return tool.call(validated, signal);
}

async function rejection(promise: Promise<unknown>): Promise<RexToolError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RexToolError) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

// ---------------------------------------------------------------------------------------------

describe("rex codemode tools", () => {
  let scope: Scope.Closeable;
  let server: IRexTestServer;
  let tools: Registered;

  beforeAll(async () => {
    scope = await Effect.runPromise(Scope.make());
    server = await Effect.runPromise(startRexTestServer().pipe(Scope.provide(scope)));
    handleEverything(server);
    tools = register(server.socketPath);
  });

  afterAll(async () => {
    for (const handler of tools.shutdown) await handler();
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  test("lists only rex_search; every operation tool is deferred in the rex namespace", () => {
    expect(tools.registered.length).toBe(rexToolOperations.length + 1);
    expect(new Set(tools.registered.map((tool) => tool.name)).size).toBe(tools.registered.length);
    const listed = tools.registered.filter((tool) => tool.exposure === "codemode");
    expect(listed.map((tool) => tool.name)).toEqual([REX_SEARCH_TOOL_NAME]);
    for (const tool of tools.registered) {
      expect(tool.namespace).toBe(rexToolNamespace);
      if (tool.name === REX_SEARCH_TOOL_NAME) continue;
      expect(tool.exposure).toBe("deferred");
      expect(tool.name).toMatch(/^rex_[a-z][A-Za-z]*(_[a-z][A-Za-z]*)+$/);
    }
  });

  test("the fork denylist applies to registration and search", async () => {
    const deniedNames = upstreamOperations
      .filter(isForkDeniedRexTool)
      .map(({ name }) => `rex_${name}`);
    expect(deniedNames).toEqual(
      expect.arrayContaining([
        "rex_windows_focus",
        "rex_blocks_focus",
        "rex_blocks_splitBeside",
        "rex_windows_create",
        "rex_clients_action",
        "rex_clients_perform",
        "rex_clients_key",
        "rex_server_stop",
      ]),
    );
    expect(
      isForkDeniedRexTool({
        name: "blocks_reverseFocus",
        method: "focus_history.reverse",
        fields: {},
        input: undefined,
      }),
    ).toBe(true);
    expect(
      isForkDeniedRexTool({
        name: "windows_switchToTab",
        method: undefined,
        fields: {},
        input: undefined,
      }),
    ).toBe(true);
    const registered = new Set(tools.registered.map(({ name }) => name));
    expect(deniedNames.filter((name) => registered.has(name))).toEqual([]);
    expect(registered.has("rex_blocks_reverseFocus")).toBe(false);

    const search = await callTool(tools.tools, REX_SEARCH_TOOL_NAME, { query: "focus", limit: 50 });
    const hits = arrayOf(fieldOf(search.structuredContent, "tools"));
    expect(hits.every((hit) => registered.has(String(fieldOf(hit, "name"))))).toBe(true);
  });

  test("every SDK operation has a tool or a stated exclusion", async () => {
    const exit = await tools.runtime.run(
      Effect.gen(function* () {
        return yield* RexSdk;
      }),
      undefined,
    );
    if (!Exit.isSuccess(exit)) throw new Error("the SDK did not build");
    const sdkPaths: string[] = [];
    const collect = (value: unknown, path: string) => {
      if (typeof value === "function") sdkPaths.push(path);
      else if (typeof value === "object" && value !== null)
        for (const [key, child] of Object.entries(value)) collect(child, `${path}.${key}`);
    };
    for (const [namespace, service] of Object.entries(exit.value)) {
      if (namespace === "config" || namespace === "ids") continue;
      collect(service, namespace);
    }
    const toolPaths = new Set(
      upstreamOperations.map((operation) => operation.name.replaceAll("_", ".")),
    );
    const excluded = new Set(Object.keys(rexToolExclusions));
    expect(sdkPaths.filter((path) => !toolPaths.has(path) && !excluded.has(path))).toEqual([]);
    expect([...excluded].filter((path) => !sdkPaths.includes(path) || toolPaths.has(path))).toEqual(
      [],
    );
    expect([...toolPaths].filter((path) => !sdkPaths.includes(path))).toEqual([]);
  });

  test("rex_search: table of contents with here, capped ranked hits, namespace filter, no traffic", async () => {
    const firstRequest = server.requests().length;
    const search = async (args: { readonly [key: string]: unknown }) =>
      (await callTool(tools.tools, REX_SEARCH_TOOL_NAME, args)).structuredContent;

    const contents = await search({});
    expect(fieldOf(contents, "instructions")).toBe(rexToolNamespace.instructions);
    expect(fieldOf(contents, "here")).toEqual({ sessionId, blockId });
    const namespaces = arrayOf(fieldOf(contents, "namespaces"));
    const counted = namespaces.reduce<number>((sum, namespace) => {
      const count = fieldOf(namespace, "tools");
      return sum + (typeof count === "number" ? count : 0);
    }, 0);
    expect(counted).toBe(rexToolOperations.length);
    expect(namespaces.map((namespace) => fieldOf(namespace, "name"))).toContain("terminals");
    expect(JSON.stringify(contents).length / 4).toBeLessThan(1_800);

    const waits = await search({ query: "wait terminal output" });
    expect(fieldOf(waits, "tools", 0, "name")).toBe("rex_terminals_waitForOutput");
    expect(arrayOf(fieldOf(waits, "tools")).length).toBe(REX_SEARCH_DEFAULT_LIMIT);

    const closes = arrayOf(fieldOf(await search({ query: "destroy", limit: 50 }), "tools"));
    expect(
      closes.some(
        (hit) =>
          fieldOf(hit, "name") === "rex_sessions_destroy" && fieldOf(hit, "destructive") === true,
      ),
    ).toBe(true);
    const read = arrayOf(fieldOf(await search({ query: "read terminal" }), "tools")).find(
      (hit) => fieldOf(hit, "name") === "rex_terminals_read",
    );
    expect(Object.keys(objectOf(read)).toSorted()).toEqual(["description", "name"]);

    const terminals = arrayOf(
      fieldOf(await search({ namespace: "terminals", limit: 50 }), "tools"),
    );
    expect(terminals.length).toBeGreaterThan(10);
    expect(
      terminals.every((hit) => String(fieldOf(hit, "name")).startsWith("rex_terminals_")),
    ).toBe(true);

    expect(await search({ query: "zzzz" })).toEqual({ tools: [], total: 0 });
    expect(server.requests().length).toBe(firstRequest);
  });

  test("every tool crosses the socket and resolves to JSON matching its output schema", async () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const firstRequest = server.requests().length;
    for (const tool of tools.registered) {
      if (tool.name === "rex_events_waitFor") {
        setTimeout(
          () => server.emit({ type: "session_destroyed", payload: { session_id: sessionId } }),
          200,
        );
      }
      const result = await callTool(tools.tools, tool.name, argumentsFor(tool.name));
      expect(result.structuredContent, tool.name).not.toBeUndefined();
      expect(JSON.parse(JSON.stringify(result.structuredContent))).toEqual(
        result.structuredContent,
      );
      const validate = ajv.compile(objectOf(tool.outputSchema));
      expect(
        validate(result.structuredContent),
        `${tool.name}: ${ajv.errorsText(validate.errors)}`,
      ).toBe(true);
    }
    const observed = new Set(
      server
        .requests()
        .slice(firstRequest)
        .map((request) => request.method),
    );
    const expected = [...Object.keys(rexWireMethods), ...Object.keys(rexBlockMethods)].filter(
      (method) => !unreachedMethods.has(method),
    );
    expect(expected.filter((method) => !observed.has(method))).toEqual([]);
    expect(server.violations()).toEqual([]);
  });

  test("flat parameters reach the wire as the SDK's positional arguments and input", async () => {
    const firstRequest = server.requests().length;
    await callTool(tools.tools, "rex_terminals_read", { ...here, trim: true });
    await callTool(tools.tools, "rex_sessions_create", {
      label: "fixture",
      initialWindows: [{ windowLabel: "Code", layout: terminal }],
    });
    const sent = (method: string) =>
      server
        .requests()
        .slice(firstRequest)
        .find((request) => request.method === method)?.payload;
    expect(sent("com.superlogical.terminal.format")).toEqual({
      session_id: sessionId,
      block_id: blockId,
      args: { trim: true, max_bytes: 524_288 },
    });
    expect(sent("session.create")).toEqual({
      label: "fixture",
      initial_windows: [
        {
          window_label: "Code",
          layout: {
            block: {
              flavor: "com.superlogical.terminal.shell",
              label: "Code",
              options: { cwd: "/tmp", command: ["ls"] },
            },
          },
        },
      ],
    });
  });

  test("rejects before any request when parameters do not match the schema", async () => {
    const firstRequest = server.requests().length;
    await expect(callTool(tools.tools, "rex_terminals_writeLine", here)).rejects.toThrow(
      /Validation failed/,
    );
    await expect(
      callTool(tools.tools, "rex_sessions_view", { sessionId, extra: 1 }),
    ).rejects.toThrow(/Validation failed/);
    for (const name of [
      "rex_terminals_waitForOutput",
      "rex_terminals_waitForExit",
      "rex_events_waitFor",
    ]) {
      const { timeoutMs: _timeoutMs, ...withoutTimeout } = argumentsFor(name);
      await expect(callTool(tools.tools, name, withoutTimeout)).rejects.toThrow(/timeoutMs/);
    }
    const malformed = await rejection(
      callTool(tools.tools, "rex_sessions_view", { sessionId: "not-a-session" }),
    );
    expect(malformed.tag).toBe("SchemaError");
    expect(server.requests().length).toBe(firstRequest);
  });

  test("a wait that passes its timeoutMs resolves to { timedOut: true }", async () => {
    const output = await callTool(tools.tools, "rex_terminals_waitForOutput", {
      ...here,
      match: { type: "substring", value: "never printed" },
      timeoutMs: 300,
    });
    expect(output.structuredContent).toEqual({ timedOut: true });
    const exit = await callTool(tools.tools, "rex_terminals_waitForExit", {
      ...here,
      timeoutMs: 300,
    });
    expect(exit.structuredContent).toEqual({ timedOut: true });
    const event = await callTool(tools.tools, "rex_events_waitFor", {
      type: "never_sent",
      timeoutMs: 300,
    });
    expect(event.structuredContent).toEqual({ timedOut: true });
  });

  test("waits resolve to { timedOut: false, value } with the SDK's result", async () => {
    // Output already on screen matches without a mark, even after the program exited.
    const output = await callTool(tools.tools, "rex_terminals_waitForOutput", {
      sessionId,
      blockId: exitedBlockId,
      match: { type: "regex", value: "^(\\w+)$" },
      timeoutMs: 1_000,
    });
    expect(output.structuredContent).toEqual({
      timedOut: false,
      match: { line: "done", text: "done", groups: ["done"], alignment: null },
    });
    const exit = await callTool(tools.tools, "rex_terminals_waitForExit", {
      sessionId,
      blockId: exitedBlockId,
      timeoutMs: 1_000,
    });
    expect(exit.structuredContent).toEqual({ timedOut: false, exit: { exitCode: 0, error: null } });
  });

  test("writeLine returns a mark; waitForOutput since it matches only what the command printed", async () => {
    const shell = { sessionId, blockId: shellBlockId };
    const terminal = startRexTestTerminal(server, shell, { content: "$ pnpm test\npassed\n$ " });
    const written = await callTool(tools.tools, "rex_terminals_writeLine", {
      ...shell,
      text: "pnpm test",
    });
    const markId = fieldOf(written.structuredContent, "markId");
    expect(markId).toMatch(/^mark-\d+$/);
    const wait = callTool(tools.tools, "rex_terminals_waitForOutput", {
      ...shell,
      since: markId,
      match: { type: "regex", value: "passed|failed" },
      timeoutMs: 2_000,
    });
    // The earlier "passed" line and the typed command don't count; this does.
    setTimeout(() => terminal.print("1 failed\n$ "), 300);
    expect((await wait).structuredContent).toEqual({
      timedOut: false,
      match: { line: "1 failed", text: "failed", groups: [], alignment: "offset" },
    });
    const otherBlock = await rejection(
      callTool(tools.tools, "rex_terminals_waitForOutput", {
        ...here,
        since: markId,
        match: { type: "substring", value: "x" },
        timeoutMs: 100,
      }),
    );
    expect(otherBlock.tag).toBe("RexUnknownMark");
  });

  test("waitForOutput rejects with RexTerminalExited when the program exits without a match", async () => {
    const error = await rejection(
      callTool(tools.tools, "rex_terminals_waitForOutput", {
        sessionId,
        blockId: exitedBlockId,
        match: { type: "substring", value: "never printed" },
        timeoutMs: 1_000,
      }),
    );
    expect(error.tag).toBe("RexTerminalExited");
  });

  test("a server rejection rejects with the SDK error tag first", async () => {
    server.handle("session.list_blocks", () =>
      Effect.succeed(rexTestServerError("session_not_found", "no such session")),
    );
    try {
      const error = await rejection(
        callTool(tools.tools, "rex_sessions_listBlocks", { sessionId }),
      );
      expect(error.tag).toBe("RexSessionNotFound");
      expect(error.message).toMatch(/^RexSessionNotFound: /);
    } finally {
      server.handle("session.list_blocks", () =>
        Effect.succeed(concrete(exampleFor.get("session.list_blocks")?.response_example)),
      );
    }
  });

  test("requestTimeoutMs bounds a stalled request with RexRequestTimeout", async () => {
    server.handle("hosts.list", () => Effect.never);
    try {
      const started = Date.now();
      const error = await rejection(
        callTool(tools.tools, "rex_hosts_list", { requestTimeoutMs: 100 }),
      );
      expect(error.tag).toBe("RexRequestTimeout");
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      server.handle("hosts.list", () =>
        Effect.succeed(concrete(exampleFor.get("hosts.list")?.response_example)),
      );
    }
  });

  test("aborting the tool call interrupts it", async () => {
    const controller = new AbortController();
    const call = callTool(
      tools.tools,
      "rex_terminals_waitForOutput",
      { ...here, match: { type: "substring", value: "never printed" }, timeoutMs: 60_000 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    expect((await rejection(call)).tag).toBe("Interrupted");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

test("a missing server rejects with the SDK's connection error, and the runtime recovers", async () => {
  const { tools, runtime } = registerRexCodemodeTools(
    { registerTool: () => undefined, on: () => undefined },
    {
      here: { sessionId: null, blockId: null },
      makeLayer: () =>
        Layer.fresh(
          rexSdkLayerFromOptions({
            server: "/tmp/rex-codemode-missing/server.sock",
            connectTimeout: "1 second",
          }),
        ),
    },
  );
  try {
    const error = await rejection(callTool(tools, "rex_server_status", {}));
    expect(error.tag).toMatch(/^RexConnection/);
  } finally {
    await runtime.dispose();
  }
});

test("tools register only inside Rex unless forced", () => {
  expect(shouldRegisterRexTools({})).toBe(false);
  expect(shouldRegisterRexTools({ REX_SESSION: sessionId })).toBe(true);
  expect(shouldRegisterRexTools({ REX_SERVER: "/tmp/rex.sock" })).toBe(true);
  expect(shouldRegisterRexTools({ PI_REX_CODEMODE: "1" })).toBe(true);
  expect(shouldRegisterRexTools({ REX_SESSION: sessionId, PI_REX_CODEMODE: "0" })).toBe(false);
  expect(rexHereFromEnv({ REX_SESSION: sessionId, REX_BLOCK: blockId })).toEqual(here);
  expect(rexHereFromEnv({})).toEqual({ sessionId: null, blockId: null });
});
