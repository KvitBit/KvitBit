import type { InvitationToken } from "@kvitbit/domain/contract";
import type { Locale } from "@kvitbit/ui-port/i18n";
import * as Effect from "effect/Effect";
import { credentialsFor, makeApiRunner } from "../../runtime/api-runtime";
import { runFeatureEffect } from "../ui-effect";

/** Uses the new credentials immediately, before React has rebuilt its API provider. */
export const acceptInvitedSignup = (input: {
  readonly origin: string;
  readonly locale: Locale;
  readonly token: InvitationToken;
  readonly bearer: string | null;
}) =>
  runFeatureEffect(
    Effect.acquireUseRelease(
      Effect.sync(() =>
        makeApiRunner(input.origin, credentialsFor(input.bearer), () => input.locale),
      ),
      (api) =>
        Effect.promise(() =>
          api.run((client) => client.invitations.accept({ params: { token: input.token } })),
        ),
      (api) => Effect.promise(api.dispose),
    ),
  );
