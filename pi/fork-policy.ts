import {
  rexToolOperations as upstreamOperations,
  type RexToolOperation,
} from "./rex-tool-operations.ts";
import { isJsonObject, rexToolParametersJsonSchema } from "./rex-tool-schemas.ts";

export type { RexToolOperation } from "./rex-tool-operations.ts";

const navigation =
  /(?:^|[._])(?:focus|reverse(?:Focus|_focus)|switch|select|activate|set(?:Active|_active))(?:[._]|[A-Z]|$)/;
const denied = new Set([
  "server.stop",
  "client.action",
  "client.perform",
  "client.key",
  "client.set_script",
  "block.close",
  "session.close_window",
  "session.close_layer",
  "session.detach_block",
  "session.move_block",
  "session.swap_blocks",
  "session.zoom_block",
  "session.float_block",
  "session.raise_layer",
  "session.lower_layer",
]);

/** Identifies tools that can take focus, change the operator's view, or stop Rex. */
export function isForkDeniedRexTool(
  operation: Pick<RexToolOperation, "name" | "method" | "fields" | "input">,
): boolean {
  const { name, method } = operation;
  if (
    navigation.test(name) ||
    (method !== undefined && (denied.has(method) || navigation.test(method)))
  ) {
    return true;
  }
  const { properties } = rexToolParametersJsonSchema(operation);
  return isJsonObject(properties) && Object.hasOwn(properties, "focus");
}

/** The tool catalog shared by registration and search. */
export const rexToolOperations = upstreamOperations.filter(
  (operation) => !isForkDeniedRexTool(operation),
);
