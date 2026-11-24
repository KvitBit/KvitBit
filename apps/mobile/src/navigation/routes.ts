/**
 * ui-port Route values to expo-router hrefs. Expo Router adds the `/app` base itself
 * (app.json experiments.baseUrl), so hrefs use base "/".
 */
import { type Route, Routes } from "@kvitbit/ui-port/view-models";
import { router } from "expo-router";

export const hrefOf = (route: Route): string => Routes.toPath(route, "/");

export const navigate = (route: Route, options: { readonly replace?: boolean } = {}): void => {
  const href = hrefOf(route);
  if (options.replace === true) router.replace(href as never);
  else router.push(href as never);
};

/** Expo Router search params can be arrays; ui-port wants the first value. */
export const param = (value: string | ReadonlyArray<string> | undefined): string | undefined =>
  typeof value === "string" ? value : value?.[0];
