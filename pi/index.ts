/**
 * Exposes rex-sdk to pi codemode scripts as `tools.rex_*` tools.
 *
 * Like Cloudflare's Code Mode MCP server, only a search tool is listed in the codemode description:
 * `rex_search` returns the usage instructions and matching tools, `describeTool(name)` gives a
 * signature, and every operation tool is deferred (callable, never listed).
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ToolDefinition,
  ToolNamespace,
} from "@earendil-works/pi-coding-agent";
import type { Layer } from "effect";
import type { TSchema } from "typebox";
import { rexSdkLayerFromOptions, type RexSdk } from "../src/index.ts";
import { rexToolOperations, type RexToolOperation } from "./fork-policy.ts";
import {
  makeRexToolProgram,
  RexToolError,
  RexToolRuntime,
  toRexToolResult,
} from "./rex-tool-runtime.ts";
import {
  rexToolOutputJsonSchema,
  rexToolParametersJsonSchema,
  rexToolVoidOutputJsonSchema,
} from "./rex-tool-schemas.ts";
import {
  rexToolInstructions,
  runRexSearch,
  toRexSearchToolDefinition,
  type RexSearchHere,
} from "./rex-tool-search.ts";

const EXTENSION_VERSION = "0.1.0";

export const rexToolNamespace: ToolNamespace = {
  name: "rex",
  description: "Rex sessions, windows, blocks (panes), terminals, and events.",
  instructions: rexToolInstructions,
};

/** A registered tool and the function its `execute` delegates to, for callers without a pi context. */
export interface RexCodemodeTool {
  readonly definition: ToolDefinition<TSchema, undefined>;
  readonly call: (params: unknown, signal?: AbortSignal) => Promise<AgentToolResult<undefined>>;
}

function paramsObject(params: unknown): { readonly [key: string]: unknown } {
  return typeof params === "object" && params !== null ? { ...params } : {};
}

/** Builds the pi tool for one Rex operation. */
export function toRexCodemodeTool(
  operation: RexToolOperation,
  runtime: RexToolRuntime,
): RexCodemodeTool {
  const call = async (params: unknown, signal?: AbortSignal) => {
    const exit = await runtime.run(
      makeRexToolProgram(operation, paramsObject(params), runtime.marks),
      signal,
    );
    try {
      return toRexToolResult(exit);
    } catch (error) {
      // A configuration failure is cached by the runtime's Layer; rebuild it on the next call.
      if (error instanceof RexToolError && error.tag === "RexConfigurationError") {
        await runtime.dispose();
      }
      throw error;
    }
  };
  return {
    call,
    definition: {
      name: `rex_${operation.name}`,
      label: `rex ${operation.name.replaceAll("_", ".")}`,
      description: operation.description,
      parameters: rexToolParametersJsonSchema({ fields: operation.fields, input: operation.input }),
      outputSchema:
        operation.output === "void"
          ? rexToolVoidOutputJsonSchema
          : rexToolOutputJsonSchema(operation.output),
      exposure: "deferred",
      namespace: rexToolNamespace,
      annotations: operation.annotations,
      execute: (_toolCallId, params, signal) => call(params, signal),
    },
  };
}

/** Whether this pi process should register Rex tools: inside a Rex terminal, or when forced on. */
export function shouldRegisterRexTools(env: NodeJS.ProcessEnv): boolean {
  if (env.PI_REX_CODEMODE === "0") return false;
  return (
    env.PI_REX_CODEMODE === "1" ||
    env.REX_SESSION !== undefined ||
    env.REX_BLOCK !== undefined ||
    env.REX_SERVER !== undefined
  );
}

/** The session and block pi runs in, as Rex sets them for its terminals. */
export function rexHereFromEnv(env: NodeJS.ProcessEnv): RexSearchHere {
  return { sessionId: env.REX_SESSION ?? null, blockId: env.REX_BLOCK ?? null };
}

/** The part of pi's ExtensionAPI the Rex tools use. */
export interface RexToolRegistrar {
  registerTool(tool: ToolDefinition<TSchema, undefined>): void;
  on(event: "session_shutdown", handler: () => unknown): unknown;
}

/**
 * Registers `rex_search` and every Rex operation tool. The SDK runtime is built on the first call
 * and disposed with the session.
 */
export function registerRexCodemodeTools(
  pi: RexToolRegistrar,
  options: {
    readonly makeLayer?: () => Layer.Layer<RexSdk, unknown>;
    readonly here?: RexSearchHere;
  } = {},
): { readonly runtime: RexToolRuntime; readonly tools: ReadonlyMap<string, RexCodemodeTool> } {
  const makeLayer =
    options.makeLayer ??
    (() =>
      rexSdkLayerFromOptions({
        client: { kind: "agent", name: "pi-rex-codemode", version: EXTENSION_VERSION },
      }));
  const runtime = new RexToolRuntime(makeLayer);
  const here = options.here ?? rexHereFromEnv(process.env);
  const searchDefinition = {
    ...toRexSearchToolDefinition(rexToolOperations, here),
    namespace: rexToolNamespace,
  };
  const tools = new Map<string, RexCodemodeTool>([
    [
      searchDefinition.name,
      {
        definition: searchDefinition,
        call: async (params) => runRexSearch(rexToolOperations, params, here),
      },
    ],
  ]);
  for (const operation of rexToolOperations) {
    const tool = toRexCodemodeTool(operation, runtime);
    tools.set(tool.definition.name, tool);
  }
  for (const tool of tools.values()) pi.registerTool(tool.definition);
  pi.on("session_shutdown", () => runtime.dispose());
  return { runtime, tools };
}

export default function rexCodemodeExtension(pi: ExtensionAPI) {
  if (!shouldRegisterRexTools(process.env)) return;
  registerRexCodemodeTools(pi);
}
