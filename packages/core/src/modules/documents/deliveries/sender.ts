/**
 * `DocumentSenderLive`: the real `DocumentSender` (send.ts) that `DocumentsLive` delegates
 * `Documents.send` / `previewSend` to.
 */
import type { CoreError, CurrentCaller } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import { IdGenerator } from "../../../shared/ids";
import { CoreStore } from "../../../store/CoreStore";
import { DocumentContacts, DocumentIssuers } from "../ports";
import { DocumentsRepo } from "../repo";
import { DocumentSender } from "../sender";
import { DeliveryJobs } from "./jobs";
import { DeliveriesRepo } from "./repo";
import { previewSend, send } from "./send";

/** Everything `DocumentSenderLive` requires. */
export type DocumentSenderDeps =
  | CoreStore
  | IdGenerator
  | DocumentsRepo
  | DeliveriesRepo
  | DocumentContacts
  | DocumentIssuers
  | DeliveryJobs;

type SenderShape = DocumentSender["Service"];
type WideSender = {
  readonly [K in keyof SenderShape]: (
    ...args: Parameters<SenderShape[K]>
  ) => Effect.Effect<Effect.Success<ReturnType<SenderShape[K]>>, CoreError, CurrentCaller>;
};

export const DocumentSenderLive: Layer.Layer<DocumentSender, never, DocumentSenderDeps> =
  Layer.effect(
    DocumentSender,
    Effect.gen(function* () {
      // Only the build dependencies: the build-time context may hold a CurrentCaller, RequestOutcome
      // or transaction frame, and providing them per call would override the caller's own.
      const context = Context.pick(
        CoreStore,
        IdGenerator,
        DocumentsRepo,
        DeliveriesRepo,
        DocumentContacts,
        DocumentIssuers,
        DeliveryJobs,
      )(yield* Effect.context<DocumentSenderDeps>());
      // The call site's context wins: caller, RequestOutcome and an enclosing transaction
      // frame (issue with send, recurring issuance), so nested sends are savepoints.
      const run = <A, E>(effect: Effect.Effect<A, E, DocumentSenderDeps | CurrentCaller>) =>
        Effect.flatMap(Effect.context<CurrentCaller>(), (callSite) =>
          Effect.provideContext(effect, Context.merge(context, callSite)),
        );
      const impl: WideSender = {
        send: (id, input, opts) => run(send(id, input, opts)),
        previewSend: (id, input) => run(previewSend(id, input)),
      };
      // One cast at the layer boundary (board #341): the domain signatures lack
      // Unavailable{database} and Conflict{idempotency_mismatch}.
      return DocumentSender.of(impl as unknown as SenderShape);
    }),
  );
