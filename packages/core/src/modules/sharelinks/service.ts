/**
 * `PublicShareLinksLive`: the domain `PublicShareLinks` tag over members.ts and visitor.ts.
 * Dependencies are captured when the layer is built; the call site's context (caller,
 * transaction frame) wins, so nested calls join an enclosing transaction.
 */

import { PublicShareLinks } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
  // Only the build dependencies: the build-time context may hold a RequestOutcome
  // or transaction frame, and providing them per call would override the caller's own.
  const buildContext = yield* Effect.context<PublicShareLinksDeps>();
  const context = Context.pick(
    CoreStore,
    IdGenerator,
    DocumentsRepo,
    DocumentDeliveryReads,
    ShareLinksRepo,
    ShareLinkKeys,
    ShareWorkspaces,
  )(buildContext);
  const run = <A, E>(effect: Effect.Effect<A, E, PublicShareLinksDeps>) =>
    Effect.flatMap(Effect.context<never>(), (callSite) =>
      Effect.provideContext(effect, Context.merge(context, callSite)),
    );
  return PublicShareLinks.of({
    create: Effect.fn("PublicShareLinks.create")((caller, id) => run(create(caller, id))),
    revoke: Effect.fn("PublicShareLinks.revoke")((caller, id) => run(revoke(caller, id))),
    views: Effect.fn("PublicShareLinks.views")((caller, id, page) => run(views(caller, id, page))),
    open: Effect.fn("PublicShareLinks.open")((caller) => run(open(caller))),
    pdf: Effect.fn("PublicShareLinks.pdf")((caller, opts) => run(pdf(caller, opts))),
    logo: Effect.fn("PublicShareLinks.logo")((caller) => run(logo(caller))),
  });
});

export const PublicShareLinksLive: Layer.Layer<PublicShareLinks, never, PublicShareLinksDeps> =
  Layer.effect(PublicShareLinks, make);
