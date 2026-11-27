/**
 * Pinned formal toolchain: fetches tla2tools.jar into formal/.cache, verifies its sha256, and
 * checks the Java major version. Every path fails closed: a checksum mismatch, a failed
 * download or a wrong JDK throws, and nothing runs TLC on an unverified jar.
 *
 * CLI: `bun formal/toolchain/toolchain.ts` prints the verified jar path and Java version.
 * `TLA2TOOLS=/path/to/tla2tools.jar` replaces the download; the file is still checksummed.
 * `FORMAL_JAVA=/path/to/java` replaces `java` on PATH; its major version is still checked.
 */

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import pinned from "./toolchain.json" with { type: "json" };

export const CACHE_DIR = Bun.fileURLToPath(new URL("../.cache", import.meta.url));

export interface Toolchain {
  readonly jar: string;
  readonly java: string;
  readonly javaVersion: string;
  readonly tlaVersion: string;
}

class ToolchainError extends Schema.TaggedError<
  ToolchainError,
  { readonly brand: unique symbol }
>()("ToolchainError", {
  message: Schema.String,
}) {}

export const sha256Of = Effect.fn("Formal.sha256Of")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const digest = yield* Digest.Digest;
  const bytes = yield* fs.readFile(file);
  return yield* digest.digestHex(Digest.sha256, bytes);
}, Effect.provide(Digest.layerWebCrypto));

const verify = Effect.fn("Formal.verifyJar")(function* (
  file: string,
  expected: string,
  origin: string,
) {
  const actual = yield* sha256Of(file);
  if (actual !== expected)
    return yield* ToolchainError.make({
      message: `tla2tools checksum mismatch for ${origin} (${file}): expected sha256 ${expected}, got ${actual}. Refusing to run TLC.`,
    });
});

/** Returns a checksum-verified tla2tools.jar, downloading it into the cache when absent. */
export const ensureJar = Effect.fn("Formal.ensureJar")(
  function* (
    override: string | undefined,
    pin: { version: string; url: string; sha256: string } = pinned.tla2tools,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (override !== undefined && override !== "") {
      // TLC runs in the model directory, so Java must load the absolute path we verified.
      const file = path.resolve(override);
      if (!(yield* fs.exists(file)))
        return yield* ToolchainError.make({ message: `TLA2TOOLS=${file} does not exist.` });
      yield* verify(file, pin.sha256, "TLA2TOOLS");
      return file;
    }
    const jar = path.join(CACHE_DIR, `tla2tools-${pin.version}.jar`);
    if (yield* fs.exists(jar)) {
      yield* verify(jar, pin.sha256, "the cached jar (delete it to re-download)");
      return jar;
    }
    yield* fs.makeDirectory(CACHE_DIR, { recursive: true });
    const response = yield* HttpClient.get(pin.url);
    if (response.status < 200 || response.status >= 300)
      return yield* ToolchainError.make({
        message: `Downloading ${pin.url} failed: HTTP ${response.status}.`,
      });
    const partial = yield* fs.makeTempFileScoped({ directory: CACHE_DIR, suffix: ".partial" });
    const content = yield* response.arrayBuffer;
    yield* fs.writeFile(partial, new Uint8Array(content));
    yield* verify(partial, pin.sha256, pin.url);
    yield* fs.rename(partial, jar);
    return jar;
  },
  Effect.scoped,
  Effect.provide(FetchHttpClient.layer),
);

const JAVA_VERSION = /version "([^"]+)"/;
const JAVA_VERSION_SEPARATOR = /[.+-]/;

const ensureJava = Effect.fn("Formal.ensureJava")(function* () {
  const java = yield* Config.String("FORMAL_JAVA").pipe(Config.withDefault("java"));
  const major = pinned.java.major;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(java, ["-version"])).pipe(
    Effect.mapError((error) =>
      ToolchainError.make({
        message: `Cannot run ${java} -version (${error.message}). Install JDK ${major} (mise install, see formal/README.md).`,
      }),
    ),
  );
  const { stdout, stderr, status } = yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
      status: child.exitCode,
    },
    { concurrency: "unbounded" },
  );
  if (status !== 0)
    return yield* ToolchainError.make({
      message: `Cannot run ${java} -version (exit ${status}). Install JDK ${major} (mise install, see formal/README.md).`,
    });
  const version = JAVA_VERSION.exec(`${stderr}${stdout}`)?.[1];
  if (version === undefined || Number(Str.split(version, JAVA_VERSION_SEPARATOR)[0]) !== major)
    return yield* ToolchainError.make({
      message: `${java} reports Java ${version ?? "unknown"}; formal checks pin JDK ${major}. Set FORMAL_JAVA or run mise install.`,
    });
  return { java, version };
}, Effect.scoped);

export const ensureToolchain = Effect.fn("Formal.ensureToolchain")(function* () {
  const { java, version } = yield* ensureJava();
  const override = yield* Config.String("TLA2TOOLS").pipe(Config.withDefault(""));
  const jar = yield* ensureJar(override);
  return { jar, java, javaVersion: version, tlaVersion: pinned.tla2tools.version };
});

if (import.meta.main) {
  BunRuntime.runMain(
    ensureToolchain().pipe(
      Effect.matchEffect({
        onSuccess: (t) =>
          Console.log(
            `tla2tools ${t.tlaVersion} (sha256 verified): ${t.jar}\njava ${t.javaVersion}: ${t.java}`,
          ),
        onFailure: (error) => {
          process.exitCode = 1;
          return Console.error(error.message);
        },
      }),
      Effect.provide(BunServices.layer),
    ),
  );
}
