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
import { SchemaErrors } from "./security";

export const API_PREFIX = "/api/v1";

/** Parse options for request payloads and queries: unknown fields are rejected. */
export const STRICT_REQUEST = { onExcessProperty: "error" } as const;

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
  // Added last, so it wraps every endpoint outermost (see security.ts on execution order).
  .middleware(SchemaErrors)
  // Strict request bodies and query strings (section 3.2). Scoped to requests: headers keep
  // Schema defaults (they carry undeclared transport headers) and responses are not affected.
  .annotate(HttpApi.PayloadParseOptions, STRICT_REQUEST)
  .annotate(HttpApi.QueryParseOptions, STRICT_REQUEST)
  .annotate(OpenApi.Title, "kvitbit API")
  .annotate(OpenApi.Version, "1.0.0") {}
