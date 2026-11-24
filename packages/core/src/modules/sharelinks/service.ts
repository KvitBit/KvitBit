/**
 * `PublicShareLinksLive`: the domain `PublicShareLinks` tag over members.ts and visitor.ts.
 * Dependencies are captured when the layer is built; the call site's context (caller,
 * transaction frame) wins, so nested calls join an enclosing transaction.
 */
import type { CurrentCaller } from "@kvitbit/domain/contract";
import { PublicShareLinks } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import { IdGenerator } from "../../shared/ids";
import { CoreStore } from "../../store/CoreStore";
import { DocumentDeliveryReads, DocumentsRepo } from "../documents";
import { create, revoke, views } from "./members";
import { ShareLinkKeys, ShareWorkspaces } from "./ports";
import { ShareLinksRepo } from "./repo";
import { logo, open, pdf } from "./visitor";

/** Everything `PublicShareLinksLive` requires. */
export type PublicShareLinksDeps =
  | CoreStore
  | IdGenerator
  | DocumentsRepo
  | DocumentDeliveryReads
  | ShareLinksRepo
  | ShareLinkKeys
  | ShareWorkspaces;

const make = Effect.gen(function* () {
  // Only the build dependencies: the build-time context may hold a CurrentCaller, RequestOutcome
  // or transaction frame, and providing them per call would override the caller's own.
  const context = Context.pick(
    CoreStore,
    IdGenerator,
    DocumentsRepo,
    DocumentDeliveryReads,
    ShareLinksRepo,
    ShareLinkKeys,
    ShareWorkspaces,
  )(yield* Effect.context<PublicShareLinksDeps>());
  const run = <A, E>(effect: Effect.Effect<A, E, PublicShareLinksDeps | CurrentCaller>) =>
    Effect.flatMap(Effect.context<CurrentCaller>(), (callSite) =>
      Effect.provideContext(effect, Context.merge(context, callSite)),
    );
  return PublicShareLinks.of({
    create: (id) => run(create(id)),
    revoke: (id) => run(revoke(id)),
    views: (id, page) => run(views(id, page)),
    open: run(open),
    pdf: (opts) => run(pdf(opts)),
    logo: run(logo),
  });
});

export const PublicShareLinksLive: Layer.Layer<PublicShareLinks, never, PublicShareLinksDeps> =
  Layer.effect(PublicShareLinks, make);
