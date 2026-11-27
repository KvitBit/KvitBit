import { alchemyLabelKeys, createInternalLabels, hasAlchemyLabels } from "@alchemy.run/gcp/Labels";
import * as Arr from "effect/Array";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  type GoogleApiNoAnswer,
  type GoogleApiRetryPolicy,
  isTransientGoogleApiStatus,
  makeGoogleApi,
} from "../google-api";

/**
 * Compute REST plumbing shared by the edge resources whose fields the
 * native beta.87 providers cannot send: authorized calls, the global
 * operation waiter, and the ownership marker kept in a description.
 */

/**
 * Whether a failed request may or may not have been applied: no answer,
 * rate limiting or a server error.
 */
/** A Compute request about one edge object failed or was refused. */
export class EdgeComputeRequestFailed extends Schema.TaggedError<
  EdgeComputeRequestFailed,
  { readonly brand: unique symbol }
>()("EdgeComputeRequestFailed", {
  resource: Schema.String,
  operation: Schema.String,
  status: Schema.NullOr(Schema.Finite),
  reason: Schema.String,
}) {
  override get message() {
    return `${this.resource}: ${this.operation} failed (${this.status ?? "no answer"}): ${this.reason}`;
  }
}

const isRequestFailure = Schema.is(EdgeComputeRequestFailed);
export const isAmbiguousFailure = (error: { readonly _tag: string }) =>
  isRequestFailure(error) && (error.status === null || isTransientGoogleApiStatus(error.status));

/**
 * An object of this name exists and carries no ownership marker of this
 * resource, so it belongs to someone else and is never changed.
 */
export class EdgeComputeResourceUnowned extends Schema.TaggedError<
  EdgeComputeResourceUnowned,
  { readonly brand: unique symbol }
>()("EdgeComputeResourceUnowned", {
  resource: Schema.String,
}) {
  override get message() {
    return `${this.resource} exists and is not owned by this stack`;
  }
}

/** The live object still differs from the declaration after an update. */
export class EdgeComputeResourceNotConverged extends Schema.TaggedError<
  EdgeComputeResourceNotConverged,
  { readonly brand: unique symbol }
>()("EdgeComputeResourceNotConverged", {
  resource: Schema.String,
  fields: Schema.Array(Schema.String),
}) {
  override get message() {
    return `${this.resource} did not converge: ${Arr.join(this.fields, ", ")}`;
  }
}

/** A Compute resource as an insert writes it; each one names itself. */
export interface ComputeResourceBody {
  readonly name: string;
  readonly description: string;
}

export const computeRoot = "https://compute.googleapis.com/compute/v1";

const computeRetry: GoogleApiRetryPolicy = {
  attemptTimeout: "30 seconds",
  backoff: "1 second",
  retries: 4,
};

const noAnswerReasons = {
  unreachable: "Compute API unreachable",
  "no-answer-in-time": "Compute API did not answer in time",
  "credentials-stalled": "credentials lookup stalled",
} satisfies Record<GoogleApiNoAnswer, string>;

/**
 * A Compute operation as the waiter reads it. The error envelope is kept:
 * an operation can come back already DONE with an error.
 */
export const ComputeOperation = Schema.Struct({
  name: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  /** The Compute ID of the object the operation changed. */
  targetId: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Finite),
      message: Schema.optional(Schema.String),
      errors: Schema.Struct({
        code: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }).pipe(Schema.Array, Schema.optional),
    }),
  ),
});
export type ComputeOperation = typeof ComputeOperation.Type;

/**
 * Compute operations on edge objects settle in seconds; the wall-clock
 * budget is the one Alchemy's native Compute waiter allows.
 */
const operationBudget = Duration.minutes(15);
const operationInterval = Duration.seconds(2);

/** The Compute error codes (`error.errors[].code`) an operation reports. */
const operationErrorCodes = (operation: ComputeOperation) =>
  Arr.flatMap(operation.error?.errors ?? [], (error) =>
    error.code === undefined ? [] : [error.code],
  );

/** A global operation finished with an error. */
class EdgeComputeOperationFailed extends Schema.TaggedError<
  EdgeComputeOperationFailed,
  { readonly brand: unique symbol }
>()(
  // biome-ignore lint/security/noSecrets: This fixed Effect error tag is a public discriminant.
  "EdgeComputeOperationFailed",
  {
    resource: Schema.String,
    operation: Schema.String,
    /** Numeric RPC code (google.rpc.Code), when reported. */
    code: Schema.UndefinedOr(Schema.Finite),
    /** Compute error code (e.g. `RESOURCE_NOT_FOUND`), when reported. */
    reason: Schema.UndefinedOr(Schema.String),
    detail: Schema.String,
  },
) {
  override get message() {
    return `${this.resource}: operation ${this.operation} failed (${this.reason ?? this.code ?? "error"}): ${this.detail}`;
  }
}

/** A global operation did not finish within the waiting budget. */
class EdgeComputeOperationTimedOut extends Schema.TaggedError<
  EdgeComputeOperationTimedOut,
  { readonly brand: unique symbol }
>()("EdgeComputeOperationTimedOut", {
  resource: Schema.String,
  operation: Schema.String,
}) {
  override get message() {
    return `${this.resource}: operation ${this.operation} did not finish within ${Duration.format(operationBudget)}`;
  }
}

/**
 * The status of an accepted operation could not be read. The change may
 * still apply, so this is never retried as a lost answer.
 */
class EdgeComputeOperationUnreadable extends Schema.TaggedError<
  EdgeComputeOperationUnreadable,
  { readonly brand: unique symbol }
>()(
  // biome-ignore lint/security/noSecrets: This fixed Effect error tag is a public discriminant.
  "EdgeComputeOperationUnreadable",
  {
    resource: Schema.String,
    operation: Schema.String,
    reason: Schema.String,
  },
) {
  override get message() {
    return `${this.resource}: operation ${this.operation} status unreadable: ${this.reason}`;
  }
}

class EdgeComputeOperationPending extends Schema.TaggedError<
  EdgeComputeOperationPending,
  { readonly brand: unique symbol }
>()("EdgeComputeOperationPending", {}) {}

/** The failure a settled operation reports, if any. */
const operationFailure = (resource: string, operation: ComputeOperation) => {
  const error = operation.error;
  const first = error?.errors?.[0];
  if (
    error === undefined ||
    (error.code === undefined && first === undefined && (error.message ?? "") === "")
  ) {
    return;
  }
  return EdgeComputeOperationFailed.make({
    resource,
    operation: operation.name ?? "",
    code: error.code,
    reason: first?.code,
    detail: first?.message ?? error.message ?? "operation failed",
  });
};

/**
 * Fail when a settled operation changed another object than the admitted
 * one: a same-name replacement appeared between the check and the write.
 */
export const requireAdmittedTarget = ({
  resource,
  admittedId,
  settled,
}: {
  readonly resource: string;
  readonly admittedId: string | undefined;
  readonly settled: ComputeOperation;
}) => {
  if (
    admittedId !== undefined &&
    settled.targetId !== undefined &&
    settled.targetId !== admittedId
  ) {
    return Effect.fail(EdgeComputeResourceUnowned.make({ resource }));
  }
  return Effect.void;
};

/**
 * A Compute mutation request with its own request ID. The ID is fixed
 * before the first attempt, so a retried attempt (after a 5xx or a lost
 * answer) is the same request: Compute returns the original operation
 * instead of applying it again, possibly to a same-name replacement.
 */
const idempotent = (request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(HttpClientRequest.setUrlParam("requestId", SecureRandom.uuidV4Unsafe()));

/** `projects/…` of a Compute URL, so full and partial links compare equal. */
export const computeResourcePath = (link: string | undefined) => {
  if (link === undefined) {
    return;
  }
  const index = Option.getOrElse(Str.indexOf("projects/")(link), () => -1);
  return index < 0 ? link : Str.slice(index)(link);
};

/** The message of a Google error body, never the request. */
const decodeErrorBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({ message: Schema.String }),
    }),
  ),
);
const errorReason = (body: string) =>
  decodeErrorBody(body).pipe(
    Option.match({
      onNone: () => "request refused",
      onSome: ({ error }) => error.message,
    }),
  );

/**
 * Authorized Compute requests about one object. A handler returns
 * `undefined` for an answer it does not accept, which fails with the
 * answer's status and Google's error message.
 */
export const makeEdgeComputeApi = Effect.fnUntraced(function* () {
  const googleApi = yield* makeGoogleApi();

  const send = <A>(
    resource: string,
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    handle: (
      response: HttpClientResponse.HttpClientResponse,
    ) => Effect.Effect<A, EdgeComputeRequestFailed> | undefined,
    policy: GoogleApiRetryPolicy = computeRetry,
  ) => {
    const failed = (status: number | null, reason: string) =>
      EdgeComputeRequestFailed.make({ resource, operation, status, reason });
    return googleApi.call({
      request: request.pipe(HttpClientRequest.acceptJson),
      policy,
      handle: (response) =>
        handle(response) ??
        response.text.pipe(
          Effect.orElseSucceed(() => ""),
          Effect.flatMap((body) => Effect.fail(failed(response.status, errorReason(body)))),
        ),
      transientStatus: (status) => failed(status, `Compute answered HTTP ${status}`),
      noAnswer: (cause) => failed(null, noAnswerReasons[cause]),
      credentialsUnavailable: () => failed(null, "credentials unavailable"),
    });
  };

  /** Decode a JSON answer; an unreadable one fails the request. */
  const decodeJson =
    <A>(body: Schema.Decoder<A>, resource: string, operation: string) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(body)),
        Effect.mapError(() =>
          EdgeComputeRequestFailed.make({
            resource,
            operation,
            status: response.status,
            reason: "unreadable Compute answer",
          }),
        ),
      );

  /** An operation answer on 200, else `undefined`. */
  const operationAnswer =
    (resource: string, operation: string) => (response: HttpClientResponse.HttpClientResponse) =>
      response.status === 200
        ? decodeJson(ComputeOperation, resource, operation)(response)
        : undefined;

  /** A GET whose 404 means the object does not exist. */
  const get = <A>(resource: string, url: string, body: Schema.Decoder<A>) =>
    send<A | undefined>(resource, "get", HttpClientRequest.get(url), (response) => {
      if (response.status === 404) {
        return Effect.undefined;
      }
      return response.status === 200 ? decodeJson(body, resource, "get")(response) : undefined;
    });

  /** A mutation answered by an operation. */
  const mutate = (
    resource: string,
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ) => send(resource, operation, idempotent(request), operationAnswer(resource, operation));

  /**
   * A mutation Compute cannot deduplicate (it takes no `requestId`, such
   * as the Cloud Armor rule methods): sent in one attempt only, so a lost
   * answer is never replayed blindly. The caller rereads before any retry.
   */
  const mutateOnce = (
    resource: string,
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ) =>
    send(resource, operation, request, operationAnswer(resource, operation), {
      ...computeRetry,
      retries: 0,
    });

  /**
   * Wait for a global operation to finish. A freshly started operation can
   * 404 for a moment; an operation finished with an error fails with
   * `EdgeComputeOperationFailed` unless one of its error codes is in
   * `ignore`, which means the desired state already holds.
   */
  const settle = Effect.fnUntraced(function* (
    resource: string,
    project: string,
    operation: ComputeOperation,
    options?: { readonly ignore?: ReadonlyArray<string> },
  ) {
    const name = operation.name ?? "";
    const poll = send(
      resource,
      "wait",
      HttpClientRequest.get(`${computeRoot}/projects/${project}/global/operations/${name}`),
      operationAnswer(resource, "wait"),
    ).pipe(
      Effect.retry({
        while: (error) => error.status === 404,
        times: 5,
        schedule: Schedule.exponential("250 millis"),
      }),
      Effect.filterOrFail(
        (current) => current.status === "DONE",
        () => EdgeComputeOperationPending.make(),
      ),
      Effect.catchTag("EdgeComputeRequestFailed", (error) =>
        Effect.fail(
          EdgeComputeOperationUnreadable.make({
            resource,
            operation: name,
            reason: error.message,
          }),
        ),
      ),
      Effect.retry({
        while: (error) => error._tag === "EdgeComputeOperationPending",
        schedule: Schedule.spaced(operationInterval),
      }),
      Effect.timeoutOrElse({
        duration: operationBudget,
        orElse: () => Effect.fail(EdgeComputeOperationTimedOut.make({ resource, operation: name })),
      }),
    );
    if (operation.status !== "DONE" && name === "") {
      return yield* EdgeComputeOperationUnreadable.make({
        resource,
        operation: name,
        reason: "Compute answered an unfinished operation without a name",
      });
    }
    const settled = operation.status === "DONE" ? operation : yield* poll;
    const failure = operationFailure(resource, settled);
    const ignore = options?.ignore ?? [];
    if (
      failure !== undefined &&
      !Arr.some(operationErrorCodes(settled), (code) => ignore.includes(code))
    ) {
      return yield* failure;
    }
    return {
      name: settled.name,
      status: settled.status,
      targetId: settled.targetId ?? operation.targetId,
    } satisfies ComputeOperation;
  });

  return {
    get,
    mutate,
    mutateOnce,
    settle,
    /** An insert's operation, or `conflict` when the name is taken. */
    insert: <Body extends ComputeResourceBody>(resource: string, url: string, body: Body) =>
      send<"conflict" | ComputeOperation>(
        resource,
        "insert",
        idempotent(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJsonUnsafe(body))),
        (response) =>
          response.status === 409
            ? Effect.succeed("conflict" as const)
            : operationAnswer(resource, "insert")(response),
      ),
    /** A delete's operation, or `gone` when nothing has the name. */
    delete: (resource: string, url: string) =>
      send<"gone" | ComputeOperation>(
        resource,
        "delete",
        idempotent(HttpClientRequest.delete(url)),
        (response) =>
          response.status === 404
            ? Effect.succeed("gone" as const)
            : operationAnswer(resource, "delete")(response),
      ),
  };
});

const ownershipTerms = /\s+/;
const leadingNewline = /^\n/;
const ownershipMarker = (labels: Record<string, string>) =>
  `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;

/**
 * The description an owned object carries: a `[alchemy …]` ownership
 * prefix, the same marker the native Logging exclusion uses, then the
 * declared description.
 */
export const ownedDescription = ({
  id,
  description,
}: {
  readonly id: string;
  readonly description: string | undefined;
}) =>
  createInternalLabels(id).pipe(
    Effect.map((labels) => {
      const marker = ownershipMarker(labels);
      return description !== undefined && description !== "" ? `${marker}\n${description}` : marker;
    }),
  );

/** The ownership labels and declared description of a live description. */
export const parseOwnedDescription = (description: string | undefined) => {
  if (description === undefined || !Str.startsWith("[alchemy ")(description)) {
    return { labels: {}, description };
  }
  const end = Option.getOrElse(Str.indexOf("]")(description), () => -1);
  if (end < 0) {
    return { labels: {}, description };
  }
  const labels: Record<string, string> = {};
  for (const part of Str.split(ownershipTerms)(Str.slice("[alchemy ".length, end)(description))) {
    const separator = Option.getOrElse(Str.indexOf("=")(part), () => -1);
    if (separator > 0) {
      labels[Str.slice(0, separator)(part)] = Str.slice(separator + 1)(part);
    }
  }
  const rest = Str.replace(leadingNewline, "")(Str.slice(end + 1)(description));
  return { labels, description: rest.length > 0 ? rest : undefined };
};

/** Whether a live description marks the object as this resource's. */
export const isOwnedDescription = ({
  id,
  description,
}: {
  readonly id: string;
  readonly description: string | undefined;
}) => hasAlchemyLabels(id, parseOwnedDescription(description).labels);

/** Read again after a mutation; a vanished object fails the reconcile. */
export const requirePresent = <A>({
  resource,
  operation,
  live,
}: {
  readonly resource: string;
  readonly operation: string;
  readonly live: A | undefined;
}) =>
  live === undefined
    ? Effect.fail(
        EdgeComputeRequestFailed.make({
          resource,
          operation,
          status: null,
          reason: "the object is missing after the change",
        }),
      )
    : Effect.succeed(live);

/**
 * Whether this resource may change the live object: it is the very object
 * Alchemy admitted (created, or adopted after a read), by its Compute ID,
 * or it carries this resource's ownership marker. A same-name object
 * someone else recreated has a new ID and no marker.
 */
export const isAdmitted = ({
  id,
  admittedId,
  live,
}: {
  readonly id: string;
  readonly admittedId: string | undefined;
  readonly live: { readonly id?: string | undefined; readonly description?: string | undefined };
}) =>
  admittedId !== undefined && admittedId !== "" && live.id === admittedId
    ? Effect.succeed(true)
    : isOwnedDescription({ id, description: live.description });
