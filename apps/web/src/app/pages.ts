import type { Html } from "@effect/ui/html";
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

const LandingPage = definePage("Landing", Landing);
const LegalPage = definePage("Legal", Legal);
const AuthPage = definePage("Auth", Auth);
const AndroidPage = definePage("Android", Android);
const SharePage = definePage("Share", Share);
const ConsentPage = definePage("Consent", Consent);
const InvitationPage = definePage("Invitation", Invitation);
const ErrorPagePage = definePage("ErrorPage", ErrorPage);
const OnboardingPage = definePage("Onboarding", Onboarding);
const DashboardPage = definePage("Dashboard", Dashboard);
const DocumentsPage = definePage("Documents", Documents);
const DocumentEditorPage = definePage("DocumentEditor", DocumentEditor);
const DocumentDetailPage = definePage("DocumentDetail", DocumentDetail);
const TemplatesPage = definePage("Templates", Templates);
const ContactsPage = definePage("Contacts", Contacts);
const PriceListPage = definePage("PriceList", PriceList);
const ExpensesPage = definePage("Expenses", Expenses);
const ReportsPage = definePage("Reports", Reports);
const SettingsPage = definePage("Settings", Settings);
const AccountPage = definePage("Account", Account);
export const viewPage = <Message>(
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
