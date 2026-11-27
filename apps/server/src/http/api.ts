/** The `Api` HttpApi at `/api/v1` with every group, its middleware and `openapi.json`. */
import { Api } from "@kvitbit/api-contract";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiScalar from "effect/http-api/HttpApiScalar";
import * as Layer from "effect/Layer";
import { EdgeMiddlewareLive } from "./edge/middleware";
import { SchemaErrorsLive } from "./edge/response";
import { ApiKeysGroupLive } from "./groups/apiKeys";
import { BotProtectionGroupLive } from "./groups/botProtection";
import { BrandingGroupLive } from "./groups/branding";
import { ConfigGroupLive } from "./groups/config";
import { ConnectedAppsGroupLive } from "./groups/connectedApps";
import { ContactsGroupLive } from "./groups/contacts";
import { DocumentsGroupLive } from "./groups/documents";
import { ExpensesGroupLive } from "./groups/expenses";
import { InvitationsGroupLive } from "./groups/invitations";
import { MeGroupLive } from "./groups/me";
import { MyWorkspacesGroupLive } from "./groups/myWorkspaces";
import { OauthConsentGroupLive } from "./groups/oauthConsent";
import { PaymentsGroupLive } from "./groups/payments";
import { PriceListGroupLive } from "./groups/priceList";
import { PublicShareGroupLive } from "./groups/publicShare";
import { RegistryGroupLive } from "./groups/registry";
import { ReportsGroupLive } from "./groups/reports";
import { ShareLinksGroupLive } from "./groups/shareLinks";
import { TeamGroupLive } from "./groups/team";
import { TemplatesGroupLive } from "./groups/templates";
import { ThemesGroupLive } from "./groups/themes";
import { WorkspaceGroupLive } from "./groups/workspace";

const ApiGroupsLive = Layer.mergeAll(
  ConfigGroupLive,
  BotProtectionGroupLive,
  PublicShareGroupLive,
  InvitationsGroupLive,
  MeGroupLive,
  MyWorkspacesGroupLive,
  OauthConsentGroupLive,
  RegistryGroupLive,
  ThemesGroupLive,
  WorkspaceGroupLive,
  TeamGroupLive,
  BrandingGroupLive,
  ApiKeysGroupLive,
  ConnectedAppsGroupLive,
  ContactsGroupLive,
  PriceListGroupLive,
  DocumentsGroupLive,
  ShareLinksGroupLive,
  PaymentsGroupLive,
  ExpensesGroupLive,
  TemplatesGroupLive,
  ReportsGroupLive,
).pipe(Layer.provide([EdgeMiddlewareLive, SchemaErrorsLive]));

/** Registers the HttpApi, OpenAPI document, and public API reference. */
export const ApiRoutesLive = Layer.merge(
  HttpApiBuilder.layer(Api, { openapiPath: "/api/v1/openapi.json" }).pipe(
    Layer.provide(ApiGroupsLive),
  ),
  HttpApiScalar.layer(Api, { path: "/api/v1/docs" }),
);
