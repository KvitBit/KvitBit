import { Head } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { WorkspaceSummary } from "@kvitbit/domain";
import { ViewModels } from "@kvitbit/ui-port";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Markup } from "../ui/html";
import type { PageCommand } from "./commands";
import { Intent } from "./intent";
import { Locale, Prefs } from "./prefs";
import { SessionState } from "./session";

const Route = ViewModels.Route.pipe(Schema.toTaggedUnion("_tag"));
export const RouteCases = Route.cases;
export type Route = ViewModels.Route;

export const PageContext = Schema.Struct({
  route: ViewModels.Route,
  path: Schema.String,
  today: Schema.String,
  prefs: Prefs,
  locale: Locale,
  session: SessionState,
  workspace: Schema.NullOr(WorkspaceSummary),
});
export type PageContext = typeof PageContext.Type;

export interface PageReturn<Model, Message> {
  readonly model: Model;
  readonly commands?: ReadonlyArray<PageCommand<Message>>;
  readonly outMessage?: Intent | undefined;
}

export type MessageHandlers<Message extends { readonly _tag: string }, Result> = {
  readonly [Tag in Message["_tag"]]: (message: Extract<Message, { readonly _tag: Tag }>) => Result;
};

const definePageImpl = <const Name extends string, Model, Message, PageRoute extends Route>(
  name: Name,
  page: {
    readonly Route: Schema.Codec<PageRoute, unknown, never, never>;
    readonly Model: Schema.Codec<Model, unknown, never, never>;
    readonly Message: Schema.Codec<Message, unknown, never, never>;
    readonly init: (route: PageRoute, ctx: PageContext) => PageReturn<Model, Message>;
    readonly update: (
      model: Model,
      message: Message,
      ctx: PageContext,
    ) => PageReturn<Model, Message>;
    readonly view: (model: Model, ctx: PageContext, h: Html.H<Message>) => Markup<Message>;
    readonly title: (model: Model, ctx: PageContext) => string;
  },
) =>
  Html.component({
    name,
    props: PageContext,
    model: page.Model,
    message: page.Message,
    events: Intent,
    // A route mount always starts its own reads and commands.
    restore: false,
  }).make({
    init: ($) => {
      // The route-to-component switch is exhaustive and selects the matching PageRoute.
      const result = page.init(
        Option.getOrThrowWith(
          Schema.decodeUnknownOption(Schema.toType(page.Route))($.props.route),
          () => new Error(`Invalid route for ${name}`),
        ),
        $.props,
      );
      const step = $.set(result.model).run(...(result.commands ?? []));
      return result.outMessage === undefined ? step : step.emit(result.outMessage);
    },
    update: ($, message) => {
      const result = page.update($.model, message, $.props);
      const step = $.set(result.model).run(...(result.commands ?? []));
      return result.outMessage === undefined ? step : step.emit(result.outMessage);
    },
    view: (h, model) => page.view(model, h.props, h),
    head: ({ model, props }) => [Head.title(`${page.title(model, props)} · Kvitbit`)],
  });

export const definePage: {
  <const Name extends string, Model, Message, PageRoute extends Route>(page: {
    readonly Route: Schema.Codec<PageRoute, unknown, never, never>;
    readonly Model: Schema.Codec<Model, unknown, never, never>;
    readonly Message: Schema.Codec<Message, unknown, never, never>;
    readonly init: (route: PageRoute, ctx: PageContext) => PageReturn<Model, Message>;
    readonly update: (
      model: Model,
      message: Message,
      ctx: PageContext,
    ) => PageReturn<Model, Message>;
    readonly view: (model: Model, ctx: PageContext, h: Html.H<Message>) => Markup<Message>;
    readonly title: (model: Model, ctx: PageContext) => string;
  }): (name: Name) => ReturnType<typeof definePageImpl<Name, Model, Message, PageRoute>>;
  <const Name extends string, Model, Message, PageRoute extends Route>(
    name: Name,
    page: {
      readonly Route: Schema.Codec<PageRoute, unknown, never, never>;
      readonly Model: Schema.Codec<Model, unknown, never, never>;
      readonly Message: Schema.Codec<Message, unknown, never, never>;
      readonly init: (route: PageRoute, ctx: PageContext) => PageReturn<Model, Message>;
      readonly update: (
        model: Model,
        message: Message,
        ctx: PageContext,
      ) => PageReturn<Model, Message>;
      readonly view: (model: Model, ctx: PageContext, h: Html.H<Message>) => Markup<Message>;
      readonly title: (model: Model, ctx: PageContext) => string;
    },
  ): ReturnType<typeof definePageImpl<Name, Model, Message, PageRoute>>;
} = Fn.dual(2, definePageImpl);
