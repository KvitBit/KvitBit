/**
 * `DocumentSenderLive`: the real `DocumentSender` (send.ts) that `DocumentsLive` delegates
 * `Documents.send` / `previewSend` to.
 */
import type { CoreError, CurrentCaller } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import type { IdGenerator } from "../../../shared/ids";
import type { CoreStore } from "../../../store/CoreStore";
import type { DocumentContacts, DocumentIssuers } from "../ports";
import type { DocumentsRepo } from "../repo";
import { DocumentSender } from "../sender";
import type { DeliveryJobs } from "./jobs";
import type { DeliveriesRepo } from "./repo";
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
      const context = yield* Effect.context<DocumentSenderDeps>();
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
