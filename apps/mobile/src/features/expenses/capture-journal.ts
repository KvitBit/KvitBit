import {
  InvalidBotProof,
  OriginRejected,
  PayloadTooLarge,
  PreconditionFailed,
  PreconditionRequired,
  RateLimited,
  Unauthorized,
} from "@kvitbit/api-contract";
import {
  Conflict,
  ExpenseId,
  ExpenseInput,
  Forbidden,
  Invalid,
  IssueCode,
  NotFound,
  Unavailable,
  WorkspaceId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";

const UiError = Schema.Union([
  NotFound,
  Forbidden,
  Invalid,
  Conflict,
  Unavailable,
  Unauthorized,
  PreconditionFailed,
  PreconditionRequired,
  RateLimited,
  PayloadTooLarge,
  InvalidBotProof,
  OriginRejected,
  Schema.TaggedStruct("Offline", {}),
  Schema.TaggedStruct("Timeout", {}),
  Schema.TaggedStruct("Cancelled", {}),
  Schema.TaggedStruct("Unexpected", {
    status: Schema.NullOr(Schema.Finite),
    requestId: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("Invalid", {
    issues: Schema.NonEmptyArray(
      Schema.Struct({
        path: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
        code: Schema.Union([IssueCode, Schema.TemplateLiteral(["auth.", Schema.String])]),
        params: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
  }),
]);

const CaptureScope = Schema.Struct({
  principalId: Schema.String,
  workspaceId: WorkspaceId,
  workspaceSlug: WorkspaceSlug,
});
export type CaptureScope = typeof CaptureScope.Type;

const CaptureFields = Schema.Struct({
  supplierName: Schema.String,
  total: Schema.String,
  currency: Schema.String,
  note: Schema.String,
});
export type CaptureFields = typeof CaptureFields.Type;

const Receipt = Schema.Struct({
  key: Schema.String,
  name: Schema.String,
  contentType: Schema.String,
  size: Schema.Finite,
});
const RejectedReceipt = Receipt.mapFields((fields) => ({ ...fields, error: UiError }));
export type RejectedReceipt = typeof RejectedReceipt.Type;

const CaptureFile = Schema.Struct({
  key: Schema.String,
  file: Schema.Struct({
    ref: Schema.String,
    name: Schema.String,
    contentType: Schema.String,
    size: Schema.Finite,
    sha256: Schema.String,
  }),
  sources: Schema.Array(Schema.String),
  result: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("uploaded") }),
      Schema.Struct({ kind: Schema.Literal("rejected"), error: UiError }),
    ]),
  ),
});
export type CaptureFile = typeof CaptureFile.Type;

const CaptureFailure = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("retry"),
    error: UiError,
    attempt: Schema.Int,
    nextAt: Schema.Finite,
  }),
  Schema.Struct({ kind: Schema.Literals(["needsSignIn", "blocked"]), error: UiError }),
  Schema.Struct({ kind: Schema.Literal("expired") }),
]);
export type CaptureFailure = typeof CaptureFailure.Type;

const CaptureJob = Schema.Struct({
  key: Schema.String,
  scope: CaptureScope,
  targetExpenseId: Schema.NullOr(ExpenseId),
  expenseId: Schema.NullOr(ExpenseId),
  recordAttemptAt: Schema.optionalKey(Schema.Finite),
  files: Schema.Array(CaptureFile),
  submission: Schema.optionalKey(
    Schema.Struct({
      fields: CaptureFields,
      payload: ExpenseInput,
      failure: Schema.optionalKey(CaptureFailure),
    }),
  ),
  done: Schema.optionalKey(Schema.Literal(true)),
});
export type CaptureJob = typeof CaptureJob.Type;

const decodeJobs = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(CaptureJob)));
const decodeRejections = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(RejectedReceipt)));

// The journal compares serialized values, including the order of persisted properties.
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const decodeCaptureJournal = (text: string) => decodeJobs(text);
export const decodeRejectedReceipts = (text: string) => decodeRejections(text);
export const encodeCaptureJournal = (
  value: readonly (string | null)[] | readonly CaptureJob[] | readonly RejectedReceipt[],
) => encodeJson(value);
