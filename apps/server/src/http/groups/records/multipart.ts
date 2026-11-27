/**
 * Streams a single multipart `file` part directly to a core consumer without buffering the file
 * in memory (http-mcp-contracts section 3.4).
 */
import { PayloadTooLarge } from "@kvitbit/api-contract";
import { Invalid } from "@kvitbit/domain/contract";
import * as Effect from "effect/Effect";
import * as Multipart from "effect/http/Multipart";
import * as Stream from "effect/Stream";

export interface StreamedFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Stream.Stream<Uint8Array>;
}

class MultipartStreamFailure {
  readonly error: Multipart.MultipartError;

  constructor(error: Multipart.MultipartError) {
    this.error = error;
  }
}

export const multipartFailureKind = {
  FileTooLarge: "size",
  BodyTooLarge: "size",
  FieldTooLarge: "size",
  TooManyParts: "shape",
  Parse: "shape",
  InternalError: "internal",
} as const satisfies Record<Multipart.MultipartErrorReason["_tag"], string>;

const malformedFile = () =>
  Invalid.make({ issues: [{ path: ["file"], code: "request.malformed" }] });

const mapMultipartError = (
  error: Multipart.MultipartError,
  limitBytes: number,
): Effect.Effect<never, Invalid | PayloadTooLarge> => {
  switch (multipartFailureKind[error.reason._tag]) {
    case "size":
      return Effect.fail(PayloadTooLarge.make({ limitBytes }));
    case "shape":
      return Effect.fail(malformedFile());
    case "internal":
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
export const streamSingleFile = Effect.fnUntraced(function* <A, E, R>(
  parts: Stream.Stream<Multipart.Part, Multipart.MultipartError>,
  limitBytes: number,
  consume: (file: StreamedFile) => Effect.Effect<A, E, R>,
) {
  const state: { result?: { value: A } } = {};

  yield* parts.pipe(
    Stream.runForEach(
      Effect.fnUntraced(function* (part) {
        if (state.result !== undefined || part._tag !== "File" || part.key !== "file") {
          return yield* malformedFile();
        }
        const bytes: Stream.Stream<Uint8Array> = part.content.pipe(
          Stream.catch((error) => Stream.die(new MultipartStreamFailure(error))),
        );
        const value = yield* consume({
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
        state.result = { value };
      }),
    ),
    Effect.catchIf(Multipart.isMultipartError, (error) => mapMultipartError(error, limitBytes)),
  );

  if (state.result === undefined) {
    return yield* malformedFile();
  }
  return state.result.value;
});
