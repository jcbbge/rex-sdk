/**
 * Refreshes the server snapshots in `schema/` and `docs/research/` from a live Rex server.
 *
 * Usage: `vp run fetch:rex-api` (uses `REX_SERVER` or the default personal server). Run it only
 * when deliberately moving the SDK to a new server release, then run `vp run generate`, review
 * the diff, and update the snapshot metadata in `package.json` and the offered revision in `src/rex-config.ts`.
 *
 * Writes `schema/rex-api.json` (`GET /api/help`), `schema/rex-block-creators.json`
 * (`block_creator.list`), and `docs/research/rex-api-revision-<N>.md` (`GET /llms.txt`).
 * `schema/rex-events.json` is transcribed by hand from the event reference in the latter.
 */
import { request } from "node:http";
import { join } from "node:path";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { RexConfig, rexConfigLayerFromOptions, type IRexConfig } from "../src/rex-config.ts";
import { RexControl, rexControlLayerWithoutDependencies } from "../src/rex-control.ts";

class RexFetchError extends Schema.TaggedError<RexFetchError>()("RexFetchError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** GETs a path from the server's HTTP endpoint, adapting Node's callback API once. */
function getRexHttp(config: IRexConfig, path: string): Effect.Effect<string, RexFetchError> {
  const endpoint = config.endpoint;
  if (endpoint._tag === "Url") {
    const url = `${endpoint.baseUrl.replace(/^ws/, "http")}${path}`;
    return Effect.tryPromise({
      try: () => fetch(url).then((response) => response.text()),
      catch: () => new RexFetchError({ path, message: `GET ${url} failed` }),
    });
  }
  return Effect.callback<string, RexFetchError>((resume) => {
    const outgoing = request({ socketPath: endpoint.path, path, method: "GET" }, (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        response.statusCode === 200
          ? resume(Effect.succeed(Buffer.concat(chunks).toString("utf8")))
          : resume(
              Effect.fail(
                new RexFetchError({ path, message: `GET ${path} answered ${response.statusCode}` }),
              ),
            ),
      );
    });
    outgoing.on("error", () =>
      resume(Effect.fail(new RexFetchError({ path, message: `GET ${path} failed` }))),
    );
    outgoing.end();
  });
}

const ApiRevision = Schema.Struct({ api_revision: Schema.Int });
const decodeApiRevision = Schema.decodeUnknownEffect(ApiRevision);
const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const fetchRexApi = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* RexConfig;
  const control = yield* RexControl;
  const root = join(import.meta.dirname, "..");

  const help = yield* decodeJsonText(yield* getRexHttp(config, "/api/help"));
  const llms = yield* getRexHttp(config, "/llms.txt");
  const version = yield* control.request("server.version", {});
  const creators = yield* control.request("block_creator.list", {});
  const { api_revision: revision } = yield* decodeApiRevision(version.payload);

  yield* fileSystem.writeFileString(
    join(root, "schema/rex-api.json"),
    `${JSON.stringify(help, null, 2)}\n`,
  );
  yield* fileSystem.writeFileString(
    join(root, "schema/rex-block-creators.json"),
    `${JSON.stringify(creators.payload, null, 2)}\n`,
  );
  yield* fileSystem.writeFileString(
    join(root, `docs/research/rex-api-revision-${revision}.md`),
    llms,
  );
  yield* Console.log(`Fetched API revision ${revision}: ${JSON.stringify(version.payload)}`);
});

NodeRuntime.runMain(
  fetchRexApi.pipe(
    Effect.provide(
      rexControlLayerWithoutDependencies.pipe(
        Layer.provideMerge(
          rexConfigLayerFromOptions({ client: { kind: "cli", name: "rex-sdk-fetch" } }),
        ),
      ),
    ),
    Effect.provide(NodeFileSystem.layer),
  ),
);
