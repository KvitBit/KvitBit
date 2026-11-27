/**
 * ui-port Route values to expo-router hrefs. Expo Router adds the `/app` base itself
 * (app.json experiments.baseUrl), so hrefs use base "/".
 */
import { type Route, Routes } from "@kvitbit/ui-port/view-models";
import * as Fn from "effect/Function";
import * as Predicate from "effect/Predicate";
import { router } from "expo-router";

export const hrefOf = (route: Route): string => Routes.toPath(route, "/");

interface NavigationOptions {
  readonly replace?: boolean;
}

export const navigate: {
  (options?: NavigationOptions): (route: Route) => void;
  (route: Route, options?: NavigationOptions): void;
} = Fn.dual(
  (args) => Predicate.hasProperty(args[0], "_tag"),
  (route: Route, options: NavigationOptions = {}) => {
    const href = hrefOf(route);
    if (options.replace === true) router.replace(href);
    else router.push(href);
  },
);

/** Expo Router search params can be arrays; ui-port wants the first value. */
export const param = (value: string | ReadonlyArray<string> | undefined): string | undefined =>
  Predicate.isString(value) ? value : value?.[0];
