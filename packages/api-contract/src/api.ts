/** The one `HttpApi` (http-mcp-contracts section 3.1). */
import { HttpApi, OpenApi } from "effect/http-api";
import {
  MeGroup,
  MyWorkspacesGroup,
  OAuthConsentGroup,
  RegistryGroup,
  ThemesGroup,
} from "./groups/account";
import { DocumentsGroup, ShareLinksGroup } from "./groups/documents";
import {
  BotProtectionGroup,
  ConfigGroup,
  InvitationsGroup,
  PublicShareGroup,
} from "./groups/public";
import {
  ContactsGroup,
  ExpensesGroup,
  PaymentsGroup,
  PriceListGroup,
  ReportsGroup,
  TemplatesGroup,
} from "./groups/records";
import {
  ApiKeysGroup,
  BrandingGroup,
  ConnectedAppsGroup,
  TeamGroup,
  WorkspaceGroup,
} from "./groups/workspace";

export const API_PREFIX = "/api/v1";

export class Api extends HttpApi.make("kvitbit")
  // public
  .add(ConfigGroup, BotProtectionGroup, PublicShareGroup, InvitationsGroup)
  // account (session only, except registry and themes)
  .add(MeGroup, MyWorkspacesGroup, OAuthConsentGroup, RegistryGroup, ThemesGroup)
  // workspace (session or API Key, then Workspaces.enter)
  .add(WorkspaceGroup, TeamGroup, BrandingGroup, ApiKeysGroup, ConnectedAppsGroup)
  .add(ContactsGroup, PriceListGroup, DocumentsGroup, ShareLinksGroup)
  .add(PaymentsGroup, ExpensesGroup, TemplatesGroup, ReportsGroup)
  .prefix(API_PREFIX)
  .annotate(OpenApi.Title, "kvitbit API")
  .annotate(OpenApi.Version, "1.0.0") {}
