/**
 * `PublicShareLinksLive`: the domain `PublicShareLinks` tag over members.ts and visitor.ts.
 * Dependencies are captured when the layer is built; the call site's context (caller,
 * transaction frame) wins, so nested calls join an enclosing transaction.
 */
import type { CoreError, CurrentCaller } from "@kvitbit/domain/contract";
import { PublicShareLinks } from "@kvitbit/domain/contract";
import { Context, Effect, Layer } from "effect";
import type { IdGenerator } from "../../shared/ids";
import type { CoreStore } from "../../store/CoreStore";
import type { DocumentDeliveryReads, DocumentsRepo } from "../documents";
import { create, revoke, views } from "./members";
import type { ShareLinkKeys, ShareWorkspaces } from "./ports";
import type { ShareLinksRepo } from "./repo";
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
  const context = yield* Effect.context<PublicShareLinksDeps>();
  const run = <A, E>(effect: Effect.Effect<A, E, PublicShareLinksDeps | CurrentCaller>) =>
    Effect.flatMap(Effect.context<CurrentCaller>(), (callSite) =>
      Effect.provideContext(effect, Context.merge(context, callSite)),
    );
  const impl = {
    create: (id: Parameters<typeof create>[0]) => run(create(id)),
    revoke: (id: Parameters<typeof revoke>[0]) => run(revoke(id)),
    views: (id: Parameters<typeof views>[0], page?: Parameters<typeof views>[1]) =>
      run(views(id, page)),
    open: run(open),
    pdf: (opts?: Parameters<typeof pdf>[0]) => run(pdf(opts)),
    logo: run(logo),
  } satisfies {
    readonly [K in keyof PublicShareLinks["Service"]]: PublicShareLinks["Service"][K] extends (
      ...args: infer P
    ) => Effect.Effect<infer A, infer _E, infer _R>
      ? (...args: P) => Effect.Effect<A, CoreError, CurrentCaller>
      : PublicShareLinks["Service"][K] extends Effect.Effect<infer A, infer _E, infer _R>
        ? Effect.Effect<A, CoreError, CurrentCaller>
        : never;
  };
  /**
   * The one cast at the layer boundary (as in DocumentsLive): methods keep their honest error
   * types. Domain signature gaps, for a domain fix at integration: create, revoke and views lack
   * Unavailable{database}; open lacks Unavailable and Forbidden (a non-visitor caller); pdf and
   * logo lack Forbidden.
   */
  return PublicShareLinks.of(impl as unknown as PublicShareLinks["Service"]);
});

export const PublicShareLinksLive: Layer.Layer<PublicShareLinks, never, PublicShareLinksDeps> =
  Layer.effect(PublicShareLinks, make);
