/**
 * Settings page (stub). Owned by the `settings` page group; replace with the screen implementation.
 * Contract: src/app/page.ts.
 */
import { ViewModels } from "@kvitbit/ui-port";
import { Schema } from "effect";
import { Submodel } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import { page, pageHeader } from "../../ui/kit";

export type Route = RouteOf<"Settings" | "More">;

export const Model = Schema.Struct({ route: ViewModels.Route });
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({ ClickedRetry: {} });
export type Message = typeof Message.Type;

export const init = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => ({
  model: { route },
});

export const update = (
  model: Model,
  message: Message,
  _ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match<PageReturn<Model, Message>>(message, { ClickedRetry: () => ({ model }) });

export const title = (_model: Model, _ctx: PageContext): string => "Settings";

export const view = Submodel.defineView<Model, Message, PageContext>((_model, _ctx, h) =>
  page(h, [pageHeader(h, { title: "Settings" })]),
);
