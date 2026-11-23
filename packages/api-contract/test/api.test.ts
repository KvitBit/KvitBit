import { describe, expect, test } from "bun:test";
import { Conflict, Forbidden, Invalid, NotFound, Unavailable } from "@kvitbit/domain/contract";
import { Context, Schema } from "effect";
import { HttpApi } from "effect/http-api";
import {
  Api,
  Authentication,
  EdgeGuard,
  InvalidBotProof,
  OriginRejected,
  PayloadTooLarge,
  PreconditionFailed,
  PreconditionRequired,
  RateLimited,
  Revisioned,
  SchemaErrors,
  SessionOnly,
  ShareLinkVisitor,
  Unauthorized,
  WorkspaceMember,
} from "../src/index";

/**
 * The endpoint tables of http-mcp-contracts section 3.5, one row per endpoint:
 * group, endpoint, method, path, success status, flags (M = If-Match, I = Idempotency-Key,
 * E = ETag/Revisioned). `{ws}` is `/api/v1/workspaces/:workspaceId`. Binary successes are
 * streamed and carry status 200 implicitly ("bin").
 */
const SPEC = `
config getConfig GET /api/v1/config 200 -
botProtection issueChallenge GET /api/v1/bot-protection/challenges/:scope 200,204 -
publicShare open GET /api/v1/share/:token 200 -
publicShare pdf GET /api/v1/share/:token/pdf bin -
publicShare logo GET /api/v1/share/:token/logo bin -
invitations peek GET /api/v1/invitations/:token 200 -
invitations accept POST /api/v1/invitations/:token/accept 200 -
me getPreferences GET /api/v1/me/preferences 200 E
me updatePreferences PATCH /api/v1/me/preferences 200 ME
myWorkspaces listMine GET /api/v1/workspaces 200 -
myWorkspaces create POST /api/v1/workspaces 201 IE
oauthConsent getConsent GET /api/v1/oauth/consents/:consentId 200 -
oauthConsent decide POST /api/v1/oauth/consents/:consentId 200 -
registry lookupCompany GET /api/v1/registry/companies/:ico 200 -
themes resolve POST /api/v1/themes/resolve 200 -
workspace current GET {ws} 200 E
workspace updateIssuingEntity PATCH {ws}/issuing-entity 200 ME
workspace updateSettings PATCH {ws}/settings 200 ME
workspace listBankAccounts GET {ws}/bank-accounts 200 -
workspace createBankAccount POST {ws}/bank-accounts 201 I
workspace updateBankAccount PUT {ws}/bank-accounts/:bankAccountId 200 -
workspace removeBankAccount DELETE {ws}/bank-accounts/:bankAccountId 204 -
workspace listSeries GET {ws}/numbering-series 200 -
workspace createSeries POST {ws}/numbering-series 201 I
workspace updateSeries PUT {ws}/numbering-series/:seriesId 200 -
workspace close POST {ws}/close 204 -
team listMembers GET {ws}/members 200 -
team setRole PUT {ws}/members/:userId/role 204 -
team removeMember DELETE {ws}/members/:userId 204 -
team leave POST {ws}/members/me/leave 204 -
team listInvitations GET {ws}/invitations 200 -
team invite POST {ws}/invitations 201 I
team revokeInvitation DELETE {ws}/invitations/:invitationId 204 -
team resendInvitation POST {ws}/invitations/:invitationId/resend 202 -
team transferOwnership POST {ws}/ownership-transfer 204 -
branding getBranding GET {ws}/branding 200 E
branding updateBranding PATCH {ws}/branding 200 ME
branding putImage PUT {ws}/branding/:image 200 -
branding getImage GET {ws}/branding/:image bin -
branding removeImage DELETE {ws}/branding/:image 204 -
branding previewPdf POST {ws}/branding/preview-pdf bin -
apiKeys listApiKeys GET {ws}/api-keys 200 -
apiKeys createApiKey POST {ws}/api-keys 201 -
apiKeys revokeApiKey DELETE {ws}/api-keys/:keyId 204 -
connectedApps listConnectedApps GET {ws}/connected-apps 200 -
connectedApps revokeConnectedApp DELETE {ws}/connected-apps/:grantId 204 -
contacts search GET {ws}/contacts 200 -
contacts get GET {ws}/contacts/:contactId 200 E
contacts create POST {ws}/contacts 201 IE
contacts update PUT {ws}/contacts/:contactId 200 ME
contacts fromIco POST {ws}/contacts/from-ico 200 E
contacts archive POST {ws}/contacts/:contactId/archive 204 -
priceList list GET {ws}/price-list-items 200 -
priceList create POST {ws}/price-list-items 201 IE
priceList update PUT {ws}/price-list-items/:itemId 200 ME
priceList archive POST {ws}/price-list-items/:itemId/archive 204 -
documents list GET {ws}/documents 200 -
documents preview POST {ws}/documents/preview 200 -
documents createDraft POST {ws}/documents 201 IE
documents issueFromInput POST {ws}/documents/issue 201 IE
documents get GET {ws}/documents/:documentId 200 E
documents edit PATCH {ws}/documents/:documentId 200 ME
documents discardDraft DELETE {ws}/documents/:documentId 204 M
documents issueDraft POST {ws}/documents/:documentId/issue 200 MIE
documents lock POST {ws}/documents/:documentId/lock 200 E
documents unlock POST {ws}/documents/:documentId/unlock 200 E
documents cancel POST {ws}/documents/:documentId/cancel 200 I
documents correct POST {ws}/documents/:documentId/credit-notes 201 IE
documents issueFinalInvoice POST {ws}/documents/:documentId/final-invoice 201 IE
documents send POST {ws}/documents/:documentId/deliveries 202 I
documents pdf GET {ws}/documents/:documentId/pdf bin -
documents history GET {ws}/documents/:documentId/history 200 -
shareLinks create PUT {ws}/documents/:documentId/share-link 200 -
shareLinks revoke DELETE {ws}/documents/:documentId/share-link 204 -
shareLinks views GET {ws}/documents/:documentId/share-link/views 200 -
payments record POST {ws}/payments 201 I
payments remove POST {ws}/payments/:paymentId/remove 204 -
payments listForDocument GET {ws}/documents/:documentId/payments 200 -
payments listForExpense GET {ws}/expenses/:expenseId/payments 200 -
expenses list GET {ws}/expenses 200 -
expenses record POST {ws}/expenses 201 IE
expenses get GET {ws}/expenses/:expenseId 200 E
expenses edit PATCH {ws}/expenses/:expenseId 200 ME
expenses remove DELETE {ws}/expenses/:expenseId 204 M
expenses attach POST {ws}/expenses/:expenseId/attachments 201 -
expenses attachment GET {ws}/expenses/:expenseId/attachments/:attachmentId bin -
expenses detach DELETE {ws}/expenses/:expenseId/attachments/:attachmentId 204 -
templates list GET {ws}/templates 200 -
templates get GET {ws}/templates/:templateId 200 E
templates create POST {ws}/templates 201 IE
templates update PUT {ws}/templates/:templateId 200 ME
templates archive POST {ws}/templates/:templateId/archive 204 -
templates setSchedule PUT {ws}/templates/:templateId/schedule 200 ME
templates removeSchedule DELETE {ws}/templates/:templateId/schedule 200 ME
templates resume POST {ws}/templates/:templateId/resume 200 E
templates runs GET {ws}/templates/:templateId/runs 200 -
templates use POST {ws}/templates/:templateId/documents 201 IE
reports run GET {ws}/reports/:report 200 -
reports export GET {ws}/reports/:report/export bin -
reports dashboard GET {ws}/reports/dashboard 200 -
reports fxRate GET {ws}/fx-rates/:currency 200 -
reports startExport POST {ws}/exports 202 I
reports getExport GET {ws}/exports/:exportId 200 -
reports exportFile GET {ws}/exports/:exportId/file bin -
`;

interface Row {
  readonly group: string;
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly status: string;
  readonly flags: string;
}
const spec: ReadonlyArray<Row> = SPEC.trim()
  .split("\n")
  .map((line) => {
    const [group = "", name = "", method = "", path = "", status = "", flags = ""] =
      line.split(" ");
    return {
      group,
      name,
      method,
      path: path.replace("{ws}", "/api/v1/workspaces/:workspaceId"),
      status,
      flags,
    };
  });

interface Reflected {
  readonly group: string;
  readonly name: string;
  readonly method: string;
  readonly path: string;
  readonly successes: ReadonlyArray<number>;
  readonly errors: ReadonlyMap<number, ReadonlyArray<Schema.Top>>;
  readonly middleware: ReadonlyArray<string>;
  readonly revisioned: boolean;
  readonly params: ReadonlyArray<string>;
  readonly headers: ReadonlyArray<string>;
}

const keysOf = (schema: Schema.Top | undefined): ReadonlyArray<string> => {
  const ast = schema?.ast;
  return ast !== undefined && "propertySignatures" in ast && Array.isArray(ast.propertySignatures)
    ? ast.propertySignatures.map((p: { name: PropertyKey }) => String(p.name))
    : [];
};

const reflected: Array<Reflected> = [];
HttpApi.reflect(Api, {
  onGroup: () => {},
  onEndpoint: ({ group, endpoint, errors, successes, middleware, mergedAnnotations }) => {
    reflected.push({
      group: group.identifier,
      name: endpoint.identifier,
      method: endpoint.method,
      path: endpoint.path,
      successes: [...successes.keys()].sort(),
      errors,
      middleware: [...middleware].map((m) => m.key),
      revisioned: Context.get(mergedAnnotations, Revisioned),
      params: keysOf(endpoint.params),
      headers: keysOf(endpoint.headers),
    });
  },
});

const find = (group: string, name: string): Reflected => {
  const hit = reflected.find((r) => r.group === group && r.name === name);
  if (hit === undefined) throw new Error(`missing ${group}.${name}`);
  return hit;
};

/** Errors declared on the endpoint itself, without middleware-supplied ones. */
const ownErrors = (group: string, name: string): ReadonlyArray<Schema.Top> => {
  let found: ReadonlyArray<Schema.Top> | undefined;
  HttpApi.reflect(Api, {
    onGroup: () => {},
    onEndpoint: ({ group: g, endpoint }) => {
      if (g.identifier === group && endpoint.identifier === name) found = [...endpoint.error];
    },
  });
  if (found === undefined) throw new Error(`missing ${group}.${name}`);
  return found;
};

const hasError = (r: Reflected, status: number, sample: unknown): boolean =>
  (r.errors.get(status) ?? []).some((schema) => Schema.is(schema)(sample));

describe("Api definition integrity", () => {
  test("has exactly the spec's 22 groups and 104 endpoints", () => {
    expect(new Set(reflected.map((r) => r.group)).size).toBe(22);
    expect(reflected.length).toBe(104);
    expect(spec.length).toBe(104);
  });

  test.each(spec.map((row) => [`${row.group}.${row.name}`, row] as const))(
    "%s matches method, path and success status",
    (_, row) => {
      const r = find(row.group, row.name);
      expect(`${r.method} ${r.path}`).toBe(`${row.method} ${row.path}`);
      const expected = row.status === "bin" ? [] : row.status.split(",").map(Number);
      expect(r.successes).toEqual(expected);
    },
  );

  test("endpoint names are unique within a group and method+path is unique", () => {
    const names = reflected.map((r) => `${r.group}.${r.name}`);
    expect(new Set(names).size).toBe(names.length);
    const routes = reflected.map((r) => `${r.method} ${r.path}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  test("every path parameter is declared, so HttpApiClient can fill the URL", () => {
    for (const r of reflected) {
      const segments = [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1] ?? "");
      expect({ endpoint: `${r.group}.${r.name}`, params: [...r.params].sort() }).toEqual({
        endpoint: `${r.group}.${r.name}`,
        params: [...segments].sort(),
      });
    }
  });

  test("If-Match endpoints take the header and answer 412 and 428", () => {
    for (const row of spec) {
      const r = find(row.group, row.name);
      const ifMatch = row.flags.includes("M");
      expect([`${row.group}.${row.name}`, r.headers.includes("if-match")]).toEqual([
        `${row.group}.${row.name}`,
        ifMatch,
      ]);
      expect(hasError(r, 412, new PreconditionFailed({ currentRevision: 3 }))).toBe(ifMatch);
      expect(hasError(r, 428, new PreconditionRequired({}))).toBe(ifMatch);
    }
  });

  test("Idempotency-Key is accepted exactly where the tables say Idem", () => {
    for (const row of spec) {
      const r = find(row.group, row.name);
      expect([`${row.group}.${row.name}`, r.headers.includes("idempotency-key")]).toEqual([
        `${row.group}.${row.name}`,
        row.flags.includes("I"),
      ]);
    }
  });

  test("Revisioned (ETag) is annotated exactly where the tables say ETag", () => {
    for (const row of spec) {
      expect([`${row.group}.${row.name}`, find(row.group, row.name).revisioned]).toEqual([
        `${row.group}.${row.name}`,
        row.flags.includes("E"),
      ]);
    }
  });

  test("middleware runs SchemaErrors → Authentication → EdgeGuard → SessionOnly → WorkspaceMember", () => {
    // HttpApiBuilder applies an endpoint's middleware in insertion order, each wrapping the
    // previous result, so execution order is the reverse of the reflected (insertion) order.
    const schema = SchemaErrors.key;
    const auth = Authentication.key;
    const guard = EdgeGuard.key;
    const member = WorkspaceMember.key;
    const session = SessionOnly.key;
    const expectations: Record<string, ReadonlyArray<string>> = {
      config: [schema],
      botProtection: [schema],
      publicShare: [schema, ShareLinkVisitor.key],
      me: [schema, auth, guard, session],
      myWorkspaces: [schema, auth, guard, session],
      oauthConsent: [schema, auth, guard, session],
      registry: [schema, auth, guard],
      themes: [schema, auth, guard],
      apiKeys: [schema, auth, guard, session, member],
      connectedApps: [schema, auth, guard, session, member],
    };
    for (const r of reflected) {
      const expected =
        r.group === "invitations"
          ? r.name === "accept"
            ? [schema, auth, guard, session]
            : [schema]
          : (expectations[r.group] ?? [schema, auth, guard, member]);
      expect([`${r.group}.${r.name}`, [...r.middleware].reverse()]).toEqual([
        `${r.group}.${r.name}`,
        [...expected],
      ]);
    }
  });

  test("every endpoint answers 422 Invalid for malformed requests (SchemaErrors)", () => {
    const malformed = new Invalid({ issues: [{ path: [], code: "request.malformed" }] });
    for (const r of reflected) {
      expect([`${r.group}.${r.name}`, hasError(r, 422, malformed)]).toEqual([
        `${r.group}.${r.name}`,
        true,
      ]);
    }
  });

  test("authenticated endpoints inherit 401 from Authentication and 403/429/413 from EdgeGuard", () => {
    for (const r of reflected) {
      const authenticated = r.middleware.includes(Authentication.key);
      expect(r.middleware.includes(EdgeGuard.key)).toBe(authenticated);
      expect(hasError(r, 401, new Unauthorized({ reason: "missing" }))).toBe(
        authenticated || (r.group === "invitations" && r.name === "accept"),
      );
      if (!authenticated) continue;
      expect(hasError(r, 403, new OriginRejected({}))).toBe(true);
      expect(hasError(r, 429, new RateLimited({ retryAfterSeconds: 1 }))).toBe(true);
      expect(hasError(r, 413, new PayloadTooLarge({ limitBytes: 1 }))).toBe(true);
      if (r.middleware.includes(WorkspaceMember.key)) {
        expect(hasError(r, 404, new NotFound({ entity: "Workspace", id: "w" }))).toBe(true);
        expect(hasError(r, 403, new Forbidden({ action: "workspace.read" }))).toBe(true);
      }
    }
  });

  test("Authentication fails only with Unauthorized; EdgeGuard owns the other edge checks", () => {
    const accepts = (errors: ReadonlySet<Schema.Top>, sample: unknown) =>
      [...errors].some((schema) => Schema.is(schema)(sample));
    const edge = [
      new OriginRejected({}),
      new RateLimited({ retryAfterSeconds: 1 }),
      new PayloadTooLarge({ limitBytes: 1 }),
    ];
    expect(Authentication.error.size).toBe(1);
    expect(accepts(Authentication.error, new Unauthorized({ reason: "missing" }))).toBe(true);
    expect(edge.some((e) => accepts(Authentication.error, e))).toBe(false);
    expect(EdgeGuard.error.size).toBe(3);
    expect(edge.every((e) => accepts(EdgeGuard.error, e))).toBe(true);
  });

  test("Idempotency-Key endpoints answer 409 idempotency_mismatch", () => {
    const mismatch = new Conflict({ reason: "idempotency_mismatch" });
    for (const r of reflected) {
      if (!r.headers.includes("idempotency-key")) continue;
      expect([`${r.group}.${r.name}`, hasError(r, 409, mismatch)]).toEqual([
        `${r.group}.${r.name}`,
        true,
      ]);
    }
  });

  test("core and edge errors carry their statuses on representative endpoints", () => {
    const edit = find("documents", "edit");
    expect(hasError(edit, 404, new NotFound({ entity: "Document", id: "d" }))).toBe(true);
    expect(
      hasError(edit, 422, new Invalid({ issues: [{ path: [], code: "request.malformed" }] })),
    ).toBe(true);
    expect(hasError(edit, 409, new Conflict({ reason: "document_locked" }))).toBe(true);
    expect(hasError(edit, 503, new Unavailable({ dependency: "database" }))).toBe(true);
    const challenge = find("botProtection", "issueChallenge");
    expect(hasError(challenge, 429, new RateLimited({ retryAfterSeconds: 5 }))).toBe(true);
    expect(hasError(challenge, 503, new Unavailable({ dependency: "database" }))).toBe(true);
    expect(hasError(challenge, 400, new InvalidBotProof({}))).toBe(false);
  });
});

/**
 * The core method each endpoint fronts (packages/domain/src/modules/*.ts) and that method's
 * error channel. `-` marks edge-only endpoints (Better Auth, apps/server services). Forbidden is
 * supplied by WorkspaceMember where it runs; elsewhere the endpoint declares it.
 */
const CORE_ERRORS = `
config.getConfig -
botProtection.issueChallenge -
publicShare.open PublicShareLinks.open NotFound
publicShare.pdf PublicShareLinks.pdf NotFound,Unavailable
publicShare.logo PublicShareLinks.logo NotFound,Unavailable
invitations.peek Workspaces.peekInvitation NotFound
invitations.accept Workspaces.acceptInvitation NotFound,Conflict,Forbidden
me.getPreferences -
me.updatePreferences -
myWorkspaces.listMine Workspaces.listMine Forbidden
myWorkspaces.create Workspaces.create Invalid,Unavailable,Forbidden
oauthConsent.getConsent Workspaces.listMine Forbidden
oauthConsent.decide Workspaces.enter NotFound,Forbidden
registry.lookupCompany Workspaces.lookupCompany Invalid,NotFound,Unavailable,Forbidden
themes.resolve -
workspace.current Workspaces.current Forbidden
workspace.updateIssuingEntity Workspaces.updateIssuingEntity Invalid,Conflict,Forbidden
workspace.updateSettings Workspaces.updateSettings Invalid,Conflict,Forbidden
workspace.listBankAccounts Workspaces.current Forbidden
workspace.createBankAccount Workspaces.saveBankAccount Invalid,NotFound,Conflict,Forbidden
workspace.updateBankAccount Workspaces.saveBankAccount Invalid,NotFound,Conflict,Forbidden
workspace.removeBankAccount Workspaces.removeBankAccount Invalid,NotFound,Conflict,Forbidden
workspace.listSeries Workspaces.listSeries Forbidden
workspace.createSeries Workspaces.configureSeries Invalid,NotFound,Conflict,Forbidden
workspace.updateSeries Workspaces.configureSeries Invalid,NotFound,Conflict,Forbidden
workspace.close Workspaces.close Invalid,Forbidden
team.listMembers Workspaces.members Forbidden
team.setRole Workspaces.setRole NotFound,Conflict,Forbidden
team.removeMember Workspaces.setRole NotFound,Conflict,Forbidden
team.leave Workspaces.leave Conflict,Forbidden
team.listInvitations Workspaces.invitations Forbidden
team.invite Workspaces.invite Invalid,Conflict,Forbidden
team.revokeInvitation Workspaces.revokeInvitation NotFound,Forbidden
team.resendInvitation Workspaces.resendInvitation NotFound,Conflict,Forbidden
team.transferOwnership Workspaces.transferOwnership NotFound,Conflict,Forbidden
branding.getBranding Workspaces.current Forbidden
branding.updateBranding Workspaces.updateSettings Invalid,Conflict,Forbidden
branding.previewPdf Workspaces.previewBranding Invalid,Unavailable,Forbidden
branding.putImage Workspaces.setBrandingImage Invalid,Unavailable,Forbidden
branding.getImage Workspaces.brandingImage NotFound,Unavailable,Forbidden
branding.removeImage Workspaces.removeBrandingImage Forbidden
apiKeys.listApiKeys -
apiKeys.createApiKey -
apiKeys.revokeApiKey -
connectedApps.listConnectedApps -
connectedApps.revokeConnectedApp -
documents.list Documents.list Invalid,Forbidden
documents.preview Documents.preview Invalid,Unavailable,Forbidden
documents.createDraft Documents.createDraft Invalid,NotFound,Unavailable,Forbidden
documents.issueFromInput Documents.issue NotFound,Forbidden,Invalid,Conflict,Unavailable
documents.get Documents.get NotFound,Forbidden
documents.edit Documents.edit NotFound,Forbidden,Invalid,Conflict,Unavailable
documents.discardDraft Documents.discardDraft NotFound,Conflict,Forbidden
documents.issueDraft Documents.issue NotFound,Forbidden,Invalid,Conflict,Unavailable
documents.lock Documents.lock NotFound,Conflict,Forbidden
documents.unlock Documents.unlock NotFound,Conflict,Forbidden
documents.cancel Documents.cancel NotFound,Forbidden,Invalid,Conflict,Unavailable
documents.correct Documents.correct NotFound,Forbidden,Invalid,Conflict,Unavailable
documents.issueFinalInvoice Documents.issueFinalInvoice NotFound,Forbidden,Invalid,Conflict,Unavailable
documents.send Documents.send NotFound,Conflict,Invalid,Forbidden
documents.pdf Documents.pdf NotFound,Unavailable,Forbidden
documents.history Documents.history NotFound,Forbidden
shareLinks.create PublicShareLinks.create NotFound,Conflict,Forbidden
shareLinks.revoke PublicShareLinks.revoke NotFound,Forbidden
shareLinks.views PublicShareLinks.views Invalid,NotFound,Forbidden
contacts.search Contacts.search Forbidden
contacts.get Contacts.get NotFound,Forbidden
contacts.create Contacts.save Invalid,NotFound,Conflict,Forbidden
contacts.update Contacts.save Invalid,NotFound,Conflict,Forbidden
contacts.fromIco Contacts.fromIco Invalid,Unavailable,Forbidden
contacts.archive Contacts.archive NotFound,Forbidden
priceList.list PriceList.list Forbidden
priceList.create PriceList.save Invalid,NotFound,Conflict,Forbidden
priceList.update PriceList.save Invalid,NotFound,Conflict,Forbidden
priceList.archive PriceList.archive NotFound,Forbidden
payments.record Payments.record NotFound,Forbidden,Invalid,Conflict,Unavailable
payments.remove Payments.remove NotFound,Conflict,Forbidden
payments.listForDocument Payments.listFor NotFound,Forbidden
payments.listForExpense Payments.listFor NotFound,Forbidden
expenses.list Expenses.list Invalid,Forbidden
expenses.record Expenses.record Invalid,NotFound,Unavailable,Forbidden
expenses.get Expenses.get NotFound,Forbidden
expenses.edit Expenses.edit NotFound,Invalid,Conflict,Unavailable,Forbidden
expenses.remove Expenses.remove NotFound,Conflict,Forbidden
expenses.attach Expenses.attach NotFound,Invalid,Unavailable,Forbidden
expenses.attachment Expenses.attachment NotFound,Unavailable,Forbidden
expenses.detach Expenses.detach NotFound,Forbidden
templates.list Templates.list Forbidden
templates.get Templates.get NotFound,Forbidden
templates.create Templates.save Invalid,NotFound,Conflict,Forbidden
templates.update Templates.save Invalid,NotFound,Conflict,Forbidden
templates.archive Templates.archive NotFound,Forbidden
templates.setSchedule Templates.schedule Invalid,NotFound,Conflict,Forbidden
templates.removeSchedule Templates.schedule Invalid,NotFound,Conflict,Forbidden
templates.resume Templates.resume NotFound,Conflict,Forbidden
templates.runs Templates.runs Invalid,NotFound,Forbidden
templates.use Templates.use NotFound,Forbidden,Invalid,Conflict,Unavailable
reports.dashboard Reports.dashboard Invalid,Forbidden
reports.run Reports.run Invalid,Forbidden
reports.export Reports.export Invalid,Forbidden
reports.fxRate Reports.fxRate Invalid,Unavailable,Forbidden
reports.startExport Reports.startExport Forbidden
reports.getExport Reports.getExport NotFound,Forbidden
reports.exportFile Reports.exportFile NotFound,Conflict,Unavailable,Forbidden
`;

describe("endpoints declare their core method's errors", () => {
  const samples: Record<string, readonly [number, unknown]> = {
    NotFound: [404, new NotFound({ entity: "Document", id: "d" })],
    Invalid: [422, new Invalid({ issues: [{ path: [], code: "request.malformed" }] })],
    Conflict: [409, new Conflict({ reason: "illegal_transition" })],
    Unavailable: [503, new Unavailable({ dependency: "database" })],
    Forbidden: [403, new Forbidden({ action: "workspace.read" })],
  };
  const rows = CORE_ERRORS.trim()
    .split("\n")
    .map((line) => {
      const [id = "", method = "", tags = ""] = line.split(" ");
      return [id, method, tags === "" ? [] : tags.split(",")] as const;
    });

  test("the table covers every endpoint", () => {
    expect(rows.map(([id]) => id).sort()).toEqual(
      reflected.map((r) => `${r.group}.${r.name}`).sort(),
    );
  });

  test.each(rows)("%s (%s)", (id, _method, tags) => {
    const [group = "", name = ""] = id.split(".");
    const r = find(group, name);
    const member = r.middleware.includes(WorkspaceMember.key);
    const own = ownErrors(group, name);
    for (const tag of tags) {
      if (tag === "Forbidden" && member) continue;
      const sample = samples[tag];
      if (sample === undefined) throw new Error(`no sample for ${tag}`);
      const [status, value] = sample;
      expect([tag, own.some((schema) => Schema.is(schema)(value))]).toEqual([tag, true]);
      expect([tag, hasError(r, status, value)]).toEqual([tag, true]);
    }
  });
});

describe("request codecs on endpoints", () => {
  const documents = Api.groups.documents.endpoints;
  const decodeQuery = Schema.decodeUnknownSync(
    documents.list.query as Schema.Top as Schema.Codec<unknown, unknown>,
  );

  test("list query decodes string-encoded filters and paging", () => {
    expect(decodeQuery({ overdue: "true", limit: "20", kind: "invoice" })).toEqual({
      overdue: true,
      limit: 20,
      kind: "invoice",
    });
  });

  test("list query rejects limit outside 1..100 and non-integers", () => {
    for (const limit of ["0", "101", "1.5", "x"]) {
      expect(() => decodeQuery({ limit })).toThrow();
    }
  });

  test("If-Match header accepts only strong revision tags", () => {
    const decodeHeaders = Schema.decodeUnknownSync(
      documents.edit.headers as Schema.Top as Schema.Codec<unknown, unknown>,
    );
    expect(decodeHeaders({ "if-match": '"7"' })).toEqual({ "if-match": '"7"' });
    for (const tag of ['W/"7"', "*", "7", '"07"']) {
      expect(() => decodeHeaders({ "if-match": tag })).toThrow();
    }
  });
});
