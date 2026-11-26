/**
 * Streams a single multipart `file` part directly to a core consumer without buffering the file
 * in memory (http-mcp-contracts section 3.4).
 */
import { PayloadTooLarge } from "@kvitbit/api-contract";
import { Invalid } from "@kvitbit/domain/contract";
import { Effect, Predicate, Stream } from "effect";
import type { Multipart } from "effect/http";

export interface StreamedFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Stream.Stream<Uint8Array>;
}

class MultipartStreamFailure {
  constructor(readonly error: Multipart.MultipartError) {}
}

const malformedFile = () =>
  new Invalid({ issues: [{ path: ["file"], code: "request.malformed" }] });

const mapMultipartError = (
  error: Multipart.MultipartError,
  limitBytes: number,
): Effect.Effect<never, Invalid | PayloadTooLarge> => {
  switch (error.reason._tag) {
    case "FileTooLarge":
    case "BodyTooLarge":
    case "FieldTooLarge":
      return Effect.fail(new PayloadTooLarge({ limitBytes }));
    case "TooManyParts":
    case "Parse":
      return Effect.fail(malformedFile());
    case "InternalError":
      return Effect.die(error);
  }
};

/**
 * Extracts the single `file` part from a streamed `multipart/form-data` payload and passes its
 * byte stream to `consume`.
 *
 * A `MultipartError` raised either while parsing headers/boundaries or while draining the file
 * stream aborts `consume` (so partial uploads are never committed) and is mapped to
 * `PayloadTooLarge` (413) for size limits or `Invalid{request.malformed}` (422) for shape/parse
 * errors.
 */
export const streamSingleFile = <A, E, R>(
  parts: Stream.Stream<Multipart.Part, Multipart.MultipartError>,
  limitBytes: number,
  consume: (file: StreamedFile) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Invalid | PayloadTooLarge, R> =>
  Effect.gen(function* () {
    let seen = false;
    let result: A | undefined;

    yield* parts.pipe(
      Stream.runForEach((part) =>
        Effect.gen(function* () {
          if (seen || part._tag !== "File" || part.key !== "file") {
            return yield* malformedFile();
          }
          seen = true;
          const bytes: Stream.Stream<Uint8Array> = part.content.pipe(
            Stream.catch((error) => Stream.die(new MultipartStreamFailure(error))),
          );
          result = yield* consume({
            name: part.name,
            contentType: part.contentType,
            bytes,
          }).pipe(
            Effect.catchDefect((defect) =>
              defect instanceof MultipartStreamFailure
                ? Effect.fail(defect.error)
                : Effect.die(defect),
            ),
          );
        }),
      ),
      Effect.catchIf(
        (error): error is Multipart.MultipartError =>
          Predicate.hasProperty(error, "_tag") && error._tag === "MultipartError",
        (error) => mapMultipartError(error, limitBytes),
      ),
    );

    if (!seen) {
      return yield* malformedFile();
    }
    return result as A;
  });
