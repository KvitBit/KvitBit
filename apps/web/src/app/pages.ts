import type { Html } from "@effect/ui/html";
import * as Fn from "effect/Function";
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
import type { Intent } from "./intent";
import { definePage, type PageContext } from "./page";

const LandingPage = definePage("Landing", {
  Route: Landing.Route,
  Model: Landing.Model,
  Message: Landing.Message,
  init: Landing.init,
  update: Landing.update,
  view: Landing.view,
  title: Landing.title,
});
const LegalPage = definePage("Legal", {
  Route: Legal.Route,
  Model: Legal.Model,
  Message: Legal.Message,
  init: Legal.init,
  update: Legal.update,
  view: Legal.view,
  title: Legal.title,
});
const AuthPage = definePage("Auth", {
  Route: Auth.Route,
  Model: Auth.Model,
  Message: Auth.Message,
  init: Auth.init,
  update: Auth.update,
  view: Auth.view,
  title: Auth.title,
});
const AndroidPage = definePage("Android", {
  Route: Android.Route,
  Model: Android.Model,
  Message: Android.Message,
  init: Android.init,
  update: Android.update,
  view: Android.view,
  title: Android.title,
});
const SharePage = definePage("Share", {
  Route: Share.Route,
  Model: Share.Model,
  Message: Share.Message,
  init: Share.init,
  update: Share.update,
  view: Share.view,
  title: Share.title,
});
const ConsentPage = definePage("Consent", {
  Route: Consent.Route,
  Model: Consent.Model,
  Message: Consent.Message,
  init: Consent.init,
  update: Consent.update,
  view: Consent.view,
  title: Consent.title,
});
const InvitationPage = definePage("Invitation", {
  Route: Invitation.Route,
  Model: Invitation.Model,
  Message: Invitation.Message,
  init: Invitation.init,
  update: Invitation.update,
  view: Invitation.view,
  title: Invitation.title,
});
const ErrorPagePage = definePage("ErrorPage", {
  Route: ErrorPage.Route,
  Model: ErrorPage.Model,
  Message: ErrorPage.Message,
  init: ErrorPage.init,
  update: ErrorPage.update,
  view: ErrorPage.view,
  title: ErrorPage.title,
});
const OnboardingPage = definePage("Onboarding", {
  Route: Onboarding.Route,
  Model: Onboarding.Model,
  Message: Onboarding.Message,
  init: Onboarding.init,
  update: Onboarding.update,
  view: Onboarding.view,
  title: Onboarding.title,
});
const DashboardPage = definePage("Dashboard", {
  Route: Dashboard.Route,
  Model: Dashboard.Model,
  Message: Dashboard.Message,
  init: Dashboard.init,
  update: Dashboard.update,
  view: Dashboard.view,
  title: Dashboard.title,
});
const DocumentsPage = definePage("Documents", {
  Route: Documents.Route,
  Model: Documents.Model,
  Message: Documents.Message,
  init: Documents.init,
  update: Documents.update,
  view: Documents.view,
  title: Documents.title,
});
const DocumentEditorPage = definePage("DocumentEditor", {
  Route: DocumentEditor.Route,
  Model: DocumentEditor.Model,
  Message: DocumentEditor.Message,
  init: DocumentEditor.init,
  update: DocumentEditor.update,
  view: DocumentEditor.view,
  title: DocumentEditor.title,
});
const DocumentDetailPage = definePage("DocumentDetail", {
  Route: DocumentDetail.Route,
  Model: DocumentDetail.Model,
  Message: DocumentDetail.Message,
  init: DocumentDetail.init,
  update: DocumentDetail.update,
  view: DocumentDetail.view,
  title: DocumentDetail.title,
});
const TemplatesPage = definePage("Templates", {
  Route: Templates.Route,
  Model: Templates.Model,
  Message: Templates.Message,
  init: Templates.init,
  update: Templates.update,
  view: Templates.view,
  title: Templates.title,
});
const ContactsPage = definePage("Contacts", {
  Route: Contacts.Route,
  Model: Contacts.Model,
  Message: Contacts.Message,
  init: Contacts.init,
  update: Contacts.update,
  view: Contacts.view,
  title: Contacts.title,
});
const PriceListPage = definePage("PriceList", {
  Route: PriceList.Route,
  Model: PriceList.Model,
  Message: PriceList.Message,
  init: PriceList.init,
  update: PriceList.update,
  view: PriceList.view,
  title: PriceList.title,
});
const ExpensesPage = definePage("Expenses", {
  Route: Expenses.Route,
  Model: Expenses.Model,
  Message: Expenses.Message,
  init: Expenses.init,
  update: Expenses.update,
  view: Expenses.view,
  title: Expenses.title,
});
const ReportsPage = definePage("Reports", {
  Route: Reports.Route,
  Model: Reports.Model,
  Message: Reports.Message,
  init: Reports.init,
  update: Reports.update,
  view: Reports.view,
  title: Reports.title,
});
const SettingsPage = definePage("Settings", {
  Route: Settings.Route,
  Model: Settings.Model,
  Message: Settings.Message,
  init: Settings.init,
  update: Settings.update,
  view: Settings.view,
  title: Settings.title,
});
const AccountPage = definePage("Account", {
  Route: Account.Route,
  Model: Account.Model,
  Message: Account.Message,
  init: Account.init,
  update: Account.update,
  view: Account.view,
  title: Account.title,
});
const viewPageImpl = <Message>(
  h: Html.H<Message>,
  ctx: PageContext,
  key: string,
  onEmit: (intent: Intent) => Message,
) => {
  const options = { props: ctx, key, onEmit };
  switch (ctx.route._tag) {
    case "Landing":
      return LandingPage(h, options);
    case "Legal":
      return LegalPage(h, options);
    case "SignUp":
    case "SignIn":
    case "CheckEmail":
    case "AuthLink":
    case "ResetPassword":
      return AuthPage(h, options);
    case "AndroidDownload":
      return AndroidPage(h, options);
    case "Share":
      return SharePage(h, options);
    case "McpConsent":
      return ConsentPage(h, options);
    case "Invitation":
      return InvitationPage(h, options);
    case "Error":
      return ErrorPagePage(h, options);
    case "Onboarding":
      return OnboardingPage(h, options);
    case "Dashboard":
      return DashboardPage(h, options);
    case "Documents":
      return DocumentsPage(h, options);
    case "DocumentNew":
    case "DocumentEdit":
      return DocumentEditorPage(h, options);
    case "Document":
      return DocumentDetailPage(h, options);
    case "Templates":
    case "Template":
      return TemplatesPage(h, options);
    case "Contacts":
    case "Contact":
      return ContactsPage(h, options);
    case "PriceList":
      return PriceListPage(h, options);
    case "Expenses":
    case "ExpenseCapture":
    case "Expense":
      return ExpensesPage(h, options);
    case "Reports":
      return ReportsPage(h, options);
    case "Settings":
    case "More":
      return SettingsPage(h, options);
    case "Account":
      return AccountPage(h, options);
  }
};

export const viewPage: {
  <Message>(
    ctx: PageContext,
    key: string,
    onEmit: (intent: Intent) => Message,
  ): (h: Html.H<Message>) => ReturnType<typeof viewPageImpl<Message>>;
  <Message>(
    h: Html.H<Message>,
    ctx: PageContext,
    key: string,
    onEmit: (intent: Intent) => Message,
  ): ReturnType<typeof viewPageImpl<Message>>;
} = Fn.dual(4, viewPageImpl);
