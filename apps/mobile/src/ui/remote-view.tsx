import { describeError, type Remote, type UiError } from "@kvitbit/ui-port/api";
import * as Option from "effect/Option";
import type { ReactNode } from "react";
import { useI18n } from "../i18n/i18n-provider";
import { Banner, Loading } from "./surface";

/** Renders a Remote: spinner first, the value (stale while reloading), a retryable banner on failure. */
export function RemoteView<A>(props: {
  readonly state: Remote<A, UiError>;
  readonly onRetry?: () => void;
  readonly children: (value: A) => ReactNode;
}) {
  const { text, t } = useI18n();
  const { state } = props;
  switch (state._tag) {
    case "Idle":
      return null;
    case "Ready":
      return <>{props.children(state.value)}</>;
    case "Loading":
      return Option.isSome(state.stale) ? props.children(state.stale.value) : <Loading />;
    case "Failed": {
      const view = describeError(state.error);
      const banner = (
        <Banner
          text={text(view.text)}
          {...(props.onRetry !== undefined && view.retryable
            ? { action: { label: t("common.action.retry"), onPress: props.onRetry } }
            : {})}
        />
      );
      return Option.isSome(state.stale) ? (
        <>
          {banner}
          {props.children(state.stale.value)}
        </>
      ) : (
        banner
      );
    }
  }
}
