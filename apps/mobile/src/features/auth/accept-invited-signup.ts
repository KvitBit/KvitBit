import type { InvitationToken } from "@kvitbit/domain/contract";
import type { Locale } from "@kvitbit/ui-port/i18n";
import { credentialsFor, makeApiRunner } from "../../runtime/api-runtime";

/** Uses the new credentials immediately, before React has rebuilt its API provider. */
export const acceptInvitedSignup = async (
  origin: string,
  locale: Locale,
  token: string,
  bearer: string | null,
) => {
  const api = makeApiRunner(origin, credentialsFor(bearer), () => locale);
  try {
    return await api.run((client) =>
      client.invitations.accept({ params: { token: token as InvitationToken } }),
    );
  } finally {
    await api.dispose();
  }
};
