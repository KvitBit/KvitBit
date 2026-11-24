/**
 * Page registry: the closed set of mounted screens. Every page module follows src/app/page.ts.
 *
 * - `initPage` mounts the page that owns a route (the Shell calls it on every route change).
 * - `updatePage` routes a page Message to the mounted page and returns `undefined` when the
 *   Message belongs to a page that is no longer mounted (a late reply after navigation), so
 *   stale data can never reach the current screen.
 * - `viewPage` embeds the page as a Foldkit Submodel with the PageContext as view inputs.
 *
 * Generated layout; keep one entry per page in each table.
 */
import { Schema } from "effect";
import { Command } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Dashboard from "../page/documents/dashboard";
import * as DocumentDetail from "../page/documents/detail";
import * as Documents from "../page/documents/documents";
import * as DocumentEditor from "../page/documents/editor";
import * as Templates from "../page/documents/templates";
import * as Android from "../page/public/android";
import * as Auth from "../page/public/auth";
import * as Consent from "../page/public/consent";
import * as ErrorPage from "../page/public/error";
import * as Invitation from "../page/public/invitation";
import * as Landing from "../page/public/landing";
import * as Legal from "../page/public/legal";
import * as Onboarding from "../page/public/onboarding";
import * as Share from "../page/public/share";
import * as Contacts from "../page/records/contacts";
import * as Expenses from "../page/records/expenses";
import * as PriceList from "../page/records/price-list";
import * as Reports from "../page/records/reports";
import * as Account from "../page/settings/account";
import * as Settings from "../page/settings/settings";
import type { WebServices } from "./api";
import type { Intent } from "./intent";
import type { PageContext, PageReturn, Route } from "./page";

export type PageKey =
  | "Landing"
  | "Legal"
  | "Auth"
  | "Android"
  | "Share"
  | "Consent"
  | "Invitation"
  | "ErrorPage"
  | "Onboarding"
  | "Dashboard"
  | "Documents"
  | "DocumentEditor"
  | "DocumentDetail"
  | "Templates"
  | "Contacts"
  | "PriceList"
  | "Expenses"
  | "Reports"
  | "Settings"
  | "Account";

export const PageModel = Schema.Union([
  Schema.TaggedStruct("Landing", { model: Landing.Model }),
  Schema.TaggedStruct("Legal", { model: Legal.Model }),
  Schema.TaggedStruct("Auth", { model: Auth.Model }),
  Schema.TaggedStruct("Android", { model: Android.Model }),
  Schema.TaggedStruct("Share", { model: Share.Model }),
  Schema.TaggedStruct("Consent", { model: Consent.Model }),
  Schema.TaggedStruct("Invitation", { model: Invitation.Model }),
  Schema.TaggedStruct("ErrorPage", { model: ErrorPage.Model }),
  Schema.TaggedStruct("Onboarding", { model: Onboarding.Model }),
  Schema.TaggedStruct("Dashboard", { model: Dashboard.Model }),
  Schema.TaggedStruct("Documents", { model: Documents.Model }),
  Schema.TaggedStruct("DocumentEditor", { model: DocumentEditor.Model }),
  Schema.TaggedStruct("DocumentDetail", { model: DocumentDetail.Model }),
  Schema.TaggedStruct("Templates", { model: Templates.Model }),
  Schema.TaggedStruct("Contacts", { model: Contacts.Model }),
  Schema.TaggedStruct("PriceList", { model: PriceList.Model }),
  Schema.TaggedStruct("Expenses", { model: Expenses.Model }),
  Schema.TaggedStruct("Reports", { model: Reports.Model }),
  Schema.TaggedStruct("Settings", { model: Settings.Model }),
  Schema.TaggedStruct("Account", { model: Account.Model }),
]);
export type PageModel = typeof PageModel.Type;

export const PageMessage = Schema.Union([
  Schema.TaggedStruct("Landing", { message: Landing.Message }),
  Schema.TaggedStruct("Legal", { message: Legal.Message }),
  Schema.TaggedStruct("Auth", { message: Auth.Message }),
  Schema.TaggedStruct("Android", { message: Android.Message }),
  Schema.TaggedStruct("Share", { message: Share.Message }),
  Schema.TaggedStruct("Consent", { message: Consent.Message }),
  Schema.TaggedStruct("Invitation", { message: Invitation.Message }),
  Schema.TaggedStruct("ErrorPage", { message: ErrorPage.Message }),
  Schema.TaggedStruct("Onboarding", { message: Onboarding.Message }),
  Schema.TaggedStruct("Dashboard", { message: Dashboard.Message }),
  Schema.TaggedStruct("Documents", { message: Documents.Message }),
  Schema.TaggedStruct("DocumentEditor", { message: DocumentEditor.Message }),
  Schema.TaggedStruct("DocumentDetail", { message: DocumentDetail.Message }),
  Schema.TaggedStruct("Templates", { message: Templates.Message }),
  Schema.TaggedStruct("Contacts", { message: Contacts.Message }),
  Schema.TaggedStruct("PriceList", { message: PriceList.Message }),
  Schema.TaggedStruct("Expenses", { message: Expenses.Message }),
  Schema.TaggedStruct("Reports", { message: Reports.Message }),
  Schema.TaggedStruct("Settings", { message: Settings.Message }),
  Schema.TaggedStruct("Account", { message: Account.Message }),
]);
export type PageMessage = typeof PageMessage.Type;

export interface PageResult {
  readonly page: PageModel;
  readonly commands: ReadonlyArray<Command.Command<PageMessage, never, WebServices>>;
  readonly outMessage: Intent | undefined;
}

const wrap = <K extends PageKey, M, Msg>(key: K, result: PageReturn<M, Msg>): PageResult => ({
  page: { _tag: key, model: result.model } as unknown as PageModel,
  commands: Command.mapMessages(
    result.commands,
    (message) => ({ _tag: key, message }) as unknown as PageMessage,
  ),
  outMessage: result.outMessage,
});

export const initPage = (route: Route, ctx: PageContext): PageResult => {
  switch (route._tag) {
    case "Landing":
      return wrap("Landing", Landing.init(route, ctx));
    case "Legal":
      return wrap("Legal", Legal.init(route, ctx));
    case "SignUp":
    case "SignIn":
    case "CheckEmail":
    case "AuthLink":
    case "ResetPassword":
      return wrap("Auth", Auth.init(route, ctx));
    case "AndroidDownload":
      return wrap("Android", Android.init(route, ctx));
    case "Share":
      return wrap("Share", Share.init(route, ctx));
    case "McpConsent":
      return wrap("Consent", Consent.init(route, ctx));
    case "Invitation":
      return wrap("Invitation", Invitation.init(route, ctx));
    case "Error":
      return wrap("ErrorPage", ErrorPage.init(route, ctx));
    case "Onboarding":
      return wrap("Onboarding", Onboarding.init(route, ctx));
    case "Dashboard":
      return wrap("Dashboard", Dashboard.init(route, ctx));
    case "Documents":
      return wrap("Documents", Documents.init(route, ctx));
    case "DocumentNew":
    case "DocumentEdit":
      return wrap("DocumentEditor", DocumentEditor.init(route, ctx));
    case "Document":
      return wrap("DocumentDetail", DocumentDetail.init(route, ctx));
    case "Templates":
    case "Template":
      return wrap("Templates", Templates.init(route, ctx));
    case "Contacts":
    case "Contact":
      return wrap("Contacts", Contacts.init(route, ctx));
    case "PriceList":
      return wrap("PriceList", PriceList.init(route, ctx));
    case "Expenses":
    case "ExpenseCapture":
    case "Expense":
      return wrap("Expenses", Expenses.init(route, ctx));
    case "Reports":
      return wrap("Reports", Reports.init(route, ctx));
    case "Settings":
    case "More":
      return wrap("Settings", Settings.init(route, ctx));
    case "Account":
      return wrap("Account", Account.init(route, ctx));
  }
};

/** `undefined`: the Message is for a page that is not mounted (stale) and is dropped. */
export const updatePage = (
  page: PageModel,
  message: PageMessage,
  ctx: PageContext,
): PageResult | undefined => {
  switch (message._tag) {
    case "Landing":
      return page._tag === "Landing"
        ? wrap("Landing", Landing.update(page.model, message.message, ctx))
        : undefined;
    case "Legal":
      return page._tag === "Legal"
        ? wrap("Legal", Legal.update(page.model, message.message, ctx))
        : undefined;
    case "Auth":
      return page._tag === "Auth"
        ? wrap("Auth", Auth.update(page.model, message.message, ctx))
        : undefined;
    case "Android":
      return page._tag === "Android"
        ? wrap("Android", Android.update(page.model, message.message, ctx))
        : undefined;
    case "Share":
      return page._tag === "Share"
        ? wrap("Share", Share.update(page.model, message.message, ctx))
        : undefined;
    case "Consent":
      return page._tag === "Consent"
        ? wrap("Consent", Consent.update(page.model, message.message, ctx))
        : undefined;
    case "Invitation":
      return page._tag === "Invitation"
        ? wrap("Invitation", Invitation.update(page.model, message.message, ctx))
        : undefined;
    case "ErrorPage":
      return page._tag === "ErrorPage"
        ? wrap("ErrorPage", ErrorPage.update(page.model, message.message, ctx))
        : undefined;
    case "Onboarding":
      return page._tag === "Onboarding"
        ? wrap("Onboarding", Onboarding.update(page.model, message.message, ctx))
        : undefined;
    case "Dashboard":
      return page._tag === "Dashboard"
        ? wrap("Dashboard", Dashboard.update(page.model, message.message, ctx))
        : undefined;
    case "Documents":
      return page._tag === "Documents"
        ? wrap("Documents", Documents.update(page.model, message.message, ctx))
        : undefined;
    case "DocumentEditor":
      return page._tag === "DocumentEditor"
        ? wrap("DocumentEditor", DocumentEditor.update(page.model, message.message, ctx))
        : undefined;
    case "DocumentDetail":
      return page._tag === "DocumentDetail"
        ? wrap("DocumentDetail", DocumentDetail.update(page.model, message.message, ctx))
        : undefined;
    case "Templates":
      return page._tag === "Templates"
        ? wrap("Templates", Templates.update(page.model, message.message, ctx))
        : undefined;
    case "Contacts":
      return page._tag === "Contacts"
        ? wrap("Contacts", Contacts.update(page.model, message.message, ctx))
        : undefined;
    case "PriceList":
      return page._tag === "PriceList"
        ? wrap("PriceList", PriceList.update(page.model, message.message, ctx))
        : undefined;
    case "Expenses":
      return page._tag === "Expenses"
        ? wrap("Expenses", Expenses.update(page.model, message.message, ctx))
        : undefined;
    case "Reports":
      return page._tag === "Reports"
        ? wrap("Reports", Reports.update(page.model, message.message, ctx))
        : undefined;
    case "Settings":
      return page._tag === "Settings"
        ? wrap("Settings", Settings.update(page.model, message.message, ctx))
        : undefined;
    case "Account":
      return page._tag === "Account"
        ? wrap("Account", Account.update(page.model, message.message, ctx))
        : undefined;
  }
};

export const viewPage = <P>(
  page: PageModel,
  ctx: PageContext,
  h: HtmlBuilder<P>,
  toParent: (message: PageMessage) => P,
): Html => {
  switch (page._tag) {
    case "Landing":
      return h.submodel({
        slotId: "page-Landing",
        model: page.model,
        view: Landing.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Landing", message }),
      });
    case "Legal":
      return h.submodel({
        slotId: "page-Legal",
        model: page.model,
        view: Legal.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Legal", message }),
      });
    case "Auth":
      return h.submodel({
        slotId: "page-Auth",
        model: page.model,
        view: Auth.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Auth", message }),
      });
    case "Android":
      return h.submodel({
        slotId: "page-Android",
        model: page.model,
        view: Android.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Android", message }),
      });
    case "Share":
      return h.submodel({
        slotId: "page-Share",
        model: page.model,
        view: Share.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Share", message }),
      });
    case "Consent":
      return h.submodel({
        slotId: "page-Consent",
        model: page.model,
        view: Consent.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Consent", message }),
      });
    case "Invitation":
      return h.submodel({
        slotId: "page-Invitation",
        model: page.model,
        view: Invitation.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Invitation", message }),
      });
    case "ErrorPage":
      return h.submodel({
        slotId: "page-ErrorPage",
        model: page.model,
        view: ErrorPage.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "ErrorPage", message }),
      });
    case "Onboarding":
      return h.submodel({
        slotId: "page-Onboarding",
        model: page.model,
        view: Onboarding.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Onboarding", message }),
      });
    case "Dashboard":
      return h.submodel({
        slotId: "page-Dashboard",
        model: page.model,
        view: Dashboard.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Dashboard", message }),
      });
    case "Documents":
      return h.submodel({
        slotId: "page-Documents",
        model: page.model,
        view: Documents.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Documents", message }),
      });
    case "DocumentEditor":
      return h.submodel({
        slotId: "page-DocumentEditor",
        model: page.model,
        view: DocumentEditor.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "DocumentEditor", message }),
      });
    case "DocumentDetail":
      return h.submodel({
        slotId: "page-DocumentDetail",
        model: page.model,
        view: DocumentDetail.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "DocumentDetail", message }),
      });
    case "Templates":
      return h.submodel({
        slotId: "page-Templates",
        model: page.model,
        view: Templates.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Templates", message }),
      });
    case "Contacts":
      return h.submodel({
        slotId: "page-Contacts",
        model: page.model,
        view: Contacts.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Contacts", message }),
      });
    case "PriceList":
      return h.submodel({
        slotId: "page-PriceList",
        model: page.model,
        view: PriceList.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "PriceList", message }),
      });
    case "Expenses":
      return h.submodel({
        slotId: "page-Expenses",
        model: page.model,
        view: Expenses.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Expenses", message }),
      });
    case "Reports":
      return h.submodel({
        slotId: "page-Reports",
        model: page.model,
        view: Reports.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Reports", message }),
      });
    case "Settings":
      return h.submodel({
        slotId: "page-Settings",
        model: page.model,
        view: Settings.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Settings", message }),
      });
    case "Account":
      return h.submodel({
        slotId: "page-Account",
        model: page.model,
        view: Account.view,
        viewInputs: ctx,
        toParentMessage: (message) => toParent({ _tag: "Account", message }),
      });
  }
};

export const pageTitle = (page: PageModel, ctx: PageContext): string => {
  switch (page._tag) {
    case "Landing":
      return Landing.title(page.model, ctx);
    case "Legal":
      return Legal.title(page.model, ctx);
    case "Auth":
      return Auth.title(page.model, ctx);
    case "Android":
      return Android.title(page.model, ctx);
    case "Share":
      return Share.title(page.model, ctx);
    case "Consent":
      return Consent.title(page.model, ctx);
    case "Invitation":
      return Invitation.title(page.model, ctx);
    case "ErrorPage":
      return ErrorPage.title(page.model, ctx);
    case "Onboarding":
      return Onboarding.title(page.model, ctx);
    case "Dashboard":
      return Dashboard.title(page.model, ctx);
    case "Documents":
      return Documents.title(page.model, ctx);
    case "DocumentEditor":
      return DocumentEditor.title(page.model, ctx);
    case "DocumentDetail":
      return DocumentDetail.title(page.model, ctx);
    case "Templates":
      return Templates.title(page.model, ctx);
    case "Contacts":
      return Contacts.title(page.model, ctx);
    case "PriceList":
      return PriceList.title(page.model, ctx);
    case "Expenses":
      return Expenses.title(page.model, ctx);
    case "Reports":
      return Reports.title(page.model, ctx);
    case "Settings":
      return Settings.title(page.model, ctx);
    case "Account":
      return Account.title(page.model, ctx);
  }
};
