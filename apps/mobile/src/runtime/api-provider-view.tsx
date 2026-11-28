import * as Effect from "effect/Effect";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { apiOrigin } from "../config/env";
import { useI18n } from "../i18n/i18n-provider";
import { ApiContext, credentialsFor, makeApiRunner } from "./api-client-runtime";
import { forkMobileEffect, fromMobilePromise } from "./request-intent";

export function ApiProvider(props: {
  readonly children: ReactNode;
  /** The session bearer on Android; null on the web, where the session cookie rides along. */
  readonly token: string | null;
  readonly origin?: string;
}) {
  const { locale } = useI18n();
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const origin = props.origin ?? apiOrigin();
  const runner = useMemo(
    () => makeApiRunner(origin, credentialsFor(props.token), () => localeRef.current),
    [origin, props.token],
  );
  useEffect(
    () => () => {
      fromMobilePromise(runner.dispose).pipe(Effect.ignore, forkMobileEffect);
    },
    [runner],
  );
  return <ApiContext.Provider value={runner}>{props.children}</ApiContext.Provider>;
}
