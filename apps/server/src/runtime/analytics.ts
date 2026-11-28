import { AccessMode, ExportFormat } from "@kvitbit/api-contract";
import { DocumentKind, ReportKind, Role, UserId, WorkspaceId } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { type EventMessage, PostHog } from "posthog-node";
import { PostHogConfig, type PostHogSettings } from "../config";

export type SignUpMethod = "email" | "invitation";
type SaveMode = "created" | "updated";

type AnalyticsEvent =
  | { readonly event: "share_link_opened" }
  | { readonly event: "user_signed_up"; readonly userId: string; readonly method: SignUpMethod }
  | {
      readonly event:
        | "workspace_created"
        | "share_link_created"
        | "invitation_accepted"
        | "expense_receipt_uploaded";
      readonly userId: string;
      readonly workspaceId: WorkspaceId;
    }
  | {
      readonly event: "document_created" | "document_issued";
      readonly userId: string;
      readonly workspaceId: WorkspaceId;
      readonly kind: DocumentKind;
      readonly source: "draft" | "direct";
    }
  | {
      readonly event: "document_draft_saved";
      readonly userId: string;
      readonly workspaceId: WorkspaceId;
      readonly kind: DocumentKind;
      readonly mode: SaveMode;
    }
  | {
      readonly event: "contact_saved";
      readonly userId: string;
      readonly workspaceId: WorkspaceId;
      readonly mode: SaveMode;
    }
  | {
      readonly event: "api_key_created" | "api_key_revoked";
      readonly userId: string;
      readonly workspaceId: WorkspaceId;
      readonly access: AccessMode;
    }
  | {
      readonly event: "team_invitation_sent";
      readonly userId: string;
      readonly workspaceId: WorkspaceId;
      readonly role: Role;
    }
  | {
      readonly event: "report_exported";
      readonly userId: string;
      readonly workspaceId: WorkspaceId;
      readonly report: ReportKind;
      readonly format: ExportFormat;
    }
  | { readonly event: "feedback_submitted"; readonly userId: string; readonly hasPin: boolean };

export class Analytics extends Context.Service<
  Analytics,
  { readonly capture: (event: AnalyticsEvent) => Effect.Effect<void> }
>()("@kvitbit/server/runtime/analytics") {}

export const AnalyticsNoop = Layer.succeed(Analytics, {
  capture: Effect.fn("Analytics.capture")(() => Effect.void),
});

const isUserId = Schema.is(UserId);
const isWorkspaceId = Schema.is(WorkspaceId);
const isDocumentKind = Schema.is(DocumentKind);
const isAccessMode = Schema.is(AccessMode);
const isRole = Schema.is(Role);
const isReportKind = Schema.is(ReportKind);
const isExportFormat = Schema.is(ExportFormat);
const isSaveMode = (value: string): value is SaveMode => value === "created" || value === "updated";

const toPostHogEvent = (input: AnalyticsEvent): EventMessage | undefined => {
  const event = input.event;
  if (event === "share_link_opened") {
    return {
      event,
      distinctId: SecureRandom.uuidV4Unsafe(),
      options: { process_person_profile: false },
    };
  }

  const distinctId = input.userId;
  if (!isUserId(distinctId)) return undefined;

  switch (event) {
    case "user_signed_up":
      return input.method === "email" || input.method === "invitation"
        ? { event, distinctId, properties: { method: input.method } }
        : undefined;
    case "workspace_created":
    case "share_link_created":
    case "invitation_accepted":
    case "expense_receipt_uploaded":
      return isWorkspaceId(input.workspaceId)
        ? { event, distinctId, properties: { workspaceId: input.workspaceId } }
        : undefined;
    case "document_created":
    case "document_issued":
      return isWorkspaceId(input.workspaceId) &&
        isDocumentKind(input.kind) &&
        (input.source === "draft" || input.source === "direct")
        ? {
            event,
            distinctId,
            properties: { workspaceId: input.workspaceId, kind: input.kind, source: input.source },
          }
        : undefined;
    case "document_draft_saved":
      return isWorkspaceId(input.workspaceId) &&
        isDocumentKind(input.kind) &&
        isSaveMode(input.mode)
        ? {
            event,
            distinctId,
            properties: { workspaceId: input.workspaceId, kind: input.kind, mode: input.mode },
          }
        : undefined;
    case "contact_saved":
      return isWorkspaceId(input.workspaceId) && isSaveMode(input.mode)
        ? {
            event,
            distinctId,
            properties: { workspaceId: input.workspaceId, mode: input.mode },
          }
        : undefined;
    case "api_key_created":
    case "api_key_revoked":
      return isWorkspaceId(input.workspaceId) && isAccessMode(input.access)
        ? {
            event,
            distinctId,
            properties: { workspaceId: input.workspaceId, access: input.access },
          }
        : undefined;
    case "team_invitation_sent":
      return isWorkspaceId(input.workspaceId) && isRole(input.role)
        ? {
            event,
            distinctId,
            properties: { workspaceId: input.workspaceId, role: input.role },
          }
        : undefined;
    case "report_exported":
      return isWorkspaceId(input.workspaceId) &&
        isReportKind(input.report) &&
        isExportFormat(input.format)
        ? {
            event,
            distinctId,
            properties: {
              workspaceId: input.workspaceId,
              report: input.report,
              format: input.format,
            },
          }
        : undefined;
    case "feedback_submitted":
      return { event, distinctId, properties: { hasPin: input.hasPin === true } };
  }
};

type AnalyticsClient = Pick<PostHog, "capture" | "on" | "shutdown">;

const makePostHogClient = ({ apiKey, host }: PostHogSettings): AnalyticsClient =>
  new PostHog(apiKey, { host, enableExceptionAutocapture: false, disableGeoip: true });

const warnCapture = Effect.logWarning("PostHog analytics capture failed");

const makeAnalyticsLayerImpl = (
  settings: PostHogSettings | null,
  makeClient: (settings: PostHogSettings) => AnalyticsClient = makePostHogClient,
): Layer.Layer<Analytics> => {
  if (settings === null) return AnalyticsNoop;

  return Layer.effect(
    Analytics,
    Effect.gen(function* () {
      const client = yield* Effect.acquireRelease(
        Effect.sync(() => makeClient(settings)),
        (activeClient) =>
          Effect.tryPromise({
            try: () => activeClient.shutdown(5_000),
            catch: () => "PostHogShutdownFailed" as const,
          }).pipe(Effect.catch(() => Effect.logWarning("PostHog analytics shutdown failed"))),
      );
      yield* Effect.withFiberSucceed((fiber) => {
        const runFork = Effect.runForkWith(fiber.context);
        client.on("error", () => {
          runFork(warnCapture);
        });
      });
      return Analytics.of({
        capture: Effect.fn("Analytics.capture")((event) =>
          Effect.try({
            try: () => {
              const message = toPostHogEvent(event);
              if (message !== undefined) client.capture(message);
            },
            catch: () => "PostHogCaptureFailed" as const,
          }).pipe(Effect.catch(() => warnCapture)),
        ),
      });
    }),
  );
};

export const makeAnalyticsLayer: {
  (
    makeClient?: (settings: PostHogSettings) => AnalyticsClient,
  ): (settings: PostHogSettings | null) => Layer.Layer<Analytics>;
  (
    settings: PostHogSettings | null,
    makeClient?: (settings: PostHogSettings) => AnalyticsClient,
  ): Layer.Layer<Analytics>;
} = Fn.dual((args) => args[0] === null || Predicate.isObject(args[0]), makeAnalyticsLayerImpl);

export const AnalyticsLive = Layer.unwrap(
  Effect.map(PostHogConfig, (settings) => makeAnalyticsLayer(settings)),
);
