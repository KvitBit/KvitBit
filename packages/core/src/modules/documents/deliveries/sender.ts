/**
 * `DocumentSenderLive`: the real `DocumentSender` (send.ts) that `DocumentsLive` delegates
 * `Documents.send` / `previewSend` to.
 */
import { CurrentCaller } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

export const DocumentSenderLive: Layer.Layer<DocumentSender, never, DocumentSenderDeps> =
  Layer.effect(
    DocumentSender,
    Effect.gen(function* () {
      // Only the build dependencies: the build-time context may hold a CurrentCaller, RequestOutcome
      // or transaction frame, and providing them per call would override the caller's own.
      const buildContext = yield* Effect.context<DocumentSenderDeps>();
      const context = Context.pick(
        CoreStore,
        IdGenerator,
        DocumentsRepo,
        DeliveriesRepo,
        DocumentContacts,
        DocumentIssuers,
        DeliveryJobs,
      )(buildContext);
      // The call site's context wins: caller, RequestOutcome and an enclosing transaction
      // frame (issue with send, recurring issuance), so nested sends are savepoints.
      const run = <A, E>(effect: Effect.Effect<A, E, DocumentSenderDeps>) =>
        Effect.flatMap(Effect.context<never>(), (callSite) =>
          Effect.provideContext(effect, Context.merge(context, callSite)),
        );
      return DocumentSender.of({
        send: Effect.fn("DocumentSender.send")((caller, id, input, opts) =>
          run(send(id, input, opts).pipe(Effect.provideService(CurrentCaller, caller))),
        ),
        previewSend: Effect.fn("DocumentSender.previewSend")((caller, id, input) =>
          run(previewSend(id, input).pipe(Effect.provideService(CurrentCaller, caller))),
        ),
      });
    }),
  );
