/**
 * The Route model shared by Web (base "/") and the PWA / Expo Router (base "/app/"),
 * ui-port-contracts 2.10. Query state lives in the route so links and back navigation restore it.
 * `Routes.toPath(Routes.fromPath(p)) == p` holds for every canonical path.
 *
 * The spec leaves the list-query, report, settings and dialog vocabularies unnamed; they are
 * defined here from screens 09-21 and can move to `@kvitbit/api-contract` unchanged.
 */
import {
  AttachmentId,
  ContactId,
  DocumentId,
  DocumentKind,
  DocumentStatus,
  ExpenseId,
  ReportKind,
  ShareToken,
  TemplateId,
  WorkspaceSlug,
} from "@kvitbit/domain/contract";
import { Option, Schema } from "effect";

// --- Vocabularies --------------------------------------------------------------------------------

export const DocumentListQuery = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(DocumentStatus),
  kind: Schema.optionalKey(DocumentKind),
  contact: Schema.optionalKey(ContactId),
});
export type DocumentListQuery = typeof DocumentListQuery.Type;

export const ContactListQuery = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  role: Schema.optionalKey(Schema.Literals(["customer", "supplier"])),
  archived: Schema.optionalKey(Schema.Boolean),
});
export type ContactListQuery = typeof ContactListQuery.Type;

export const ExpenseListQuery = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  incomplete: Schema.optionalKey(Schema.Boolean),
});
export type ExpenseListQuery = typeof ExpenseListQuery.Type;

export const ReportTab = ReportKind;
export type ReportTab = typeof ReportTab.Type;

/** A report period: a year `2026`, a quarter `2026-Q4` or a month `2026-11`. */
export const Period = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d{4}(?:-Q[1-4]|-(?:0[1-9]|1[0-2]))?$/)),
);
export type Period = typeof Period.Type;

/** Settings sections of screens 19-21. */
export const SettingsSection = Schema.Literals([
  "issuingEntity",
  "taxRegime",
  "bankAccounts",
  "branding",
  "numbering",
  "documentDefaults",
  "reminders",
  "team",
  "apiKeys",
  "connectedApps",
  "dangerZone",
]);
export type SettingsSection = typeof SettingsSection.Type;

/** Dialogs a Document detail can open from a link (screens 11 and 13). */
export const DocumentDialog = Schema.Literals(["issue", "payment", "send", "cancel", "correct"]);
export type DocumentDialog = typeof DocumentDialog.Type;

export const ContactRef = Schema.TaggedStruct("Contact", { id: ContactId });
export const TemplateRef = Schema.TaggedStruct("Template", { id: TemplateId });
export const DuplicateRef = Schema.TaggedStruct("Duplicate", { id: DocumentId });
export const EditorSource = Schema.Union([ContactRef, TemplateRef, DuplicateRef]);
export type EditorSource = typeof EditorSource.Type;

// --- Route ---------------------------------------------------------------------------------------

const ws = WorkspaceSlug;
const opt = Schema.optionalKey;

export const Route = Schema.Union([
  // Public
  Schema.TaggedStruct("Landing", {}),
  Schema.TaggedStruct("Legal", { page: Schema.Literals(["terms", "privacy"]) }),
  Schema.TaggedStruct("SignUp", { invitation: opt(Schema.String) }),
  Schema.TaggedStruct("SignIn", { returnTo: opt(Schema.String) }),
  Schema.TaggedStruct("CheckEmail", { email: Schema.String }),
  Schema.TaggedStruct("AuthLink", {
    kind: Schema.Literals(["verify", "magic", "reset"]),
    token: Schema.String,
  }),
  Schema.TaggedStruct("ResetPassword", { token: opt(Schema.String) }),
  Schema.TaggedStruct("AndroidDownload", {}),
  Schema.TaggedStruct("Share", { token: ShareToken }),
  Schema.TaggedStruct("McpConsent", { consentId: Schema.String }),
  Schema.TaggedStruct("Invitation", { token: Schema.String }),
  Schema.TaggedStruct("Error", {
    kind: Schema.Literals(["not_found", "no_access", "server", "offline"]),
  }),
  // Account scope
  Schema.TaggedStruct("Onboarding", { step: opt(Schema.Int) }),
  Schema.TaggedStruct("Account", {
    tab: Schema.Literals(["profile", "appearance", "security", "sessions", "danger"]),
  }),
  // Workspace scope
  Schema.TaggedStruct("Dashboard", { ws }),
  Schema.TaggedStruct("Documents", { ws, query: DocumentListQuery }),
  Schema.TaggedStruct("DocumentNew", {
    ws,
    kind: Schema.Literals(["invoice", "proforma"]),
    from: opt(EditorSource),
  }),
  Schema.TaggedStruct("DocumentEdit", { ws, id: DocumentId }),
  Schema.TaggedStruct("Document", {
    ws,
    id: DocumentId,
    tab: Schema.Literals(["preview", "payments", "share", "history"]),
    dialog: opt(DocumentDialog),
  }),
  Schema.TaggedStruct("Templates", { ws }),
  Schema.TaggedStruct("Template", {
    ws,
    id: Schema.Union([TemplateId, Schema.Literal("new")]),
    tab: Schema.Literals(["template", "schedule", "runs"]),
  }),
  Schema.TaggedStruct("Expenses", { ws, query: ExpenseListQuery }),
  Schema.TaggedStruct("ExpenseCapture", { ws }),
  Schema.TaggedStruct("Expense", {
    ws,
    id: Schema.Union([ExpenseId, Schema.Literal("new")]),
    mode: Schema.Literals(["view", "edit"]),
    attachment: opt(AttachmentId),
    job: opt(Schema.String),
  }),
  Schema.TaggedStruct("Contacts", { ws, query: ContactListQuery }),
  Schema.TaggedStruct("Contact", {
    ws,
    id: Schema.Union([ContactId, Schema.Literal("new")]),
    mode: Schema.Literals(["view", "edit"]),
  }),
  Schema.TaggedStruct("PriceList", { ws, text: opt(Schema.String) }),
  Schema.TaggedStruct("Reports", { ws, report: ReportTab, period: Period }),
  Schema.TaggedStruct("Settings", { ws, section: SettingsSection }),
  Schema.TaggedStruct("More", { ws }), // mobile navigation bar tab; web redirects to Settings
]);
export type Route = typeof Route.Type;
export type RouteTag = Route["_tag"];
export type RouteOf<T extends RouteTag> = Extract<Route, { readonly _tag: T }>;
export type WorkspaceRoute = Extract<Route, { readonly ws: WorkspaceSlug }>;

export type RouteBase = "/" | "/app/";

// --- Path codec ----------------------------------------------------------------------------------

/** camelCase or snake_case literal -> kebab-case path segment. */
const kebab = (value: string): string =>
  value.replace(/_/g, "-").replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const unkebab = (segment: string, values: ReadonlyArray<string>): string | undefined =>
  values.find((v) => kebab(v) === segment);

const SETTINGS_SECTIONS = SettingsSection.literals;
const ERROR_KINDS = ["not_found", "no_access", "server", "offline"] as const;
const REPORT_KINDS = ReportKind.literals;

type Query = ReadonlyArray<readonly [string, string | undefined]>;

const enc = (value: string): string => encodeURIComponent(value);
const dec = (value: string): string | undefined => {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return undefined;
  }
};

const withQuery = (path: string, query: Query): string => {
  const parts = query.flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${enc(v)}`]));
  return parts.length === 0 ? path : `${path}?${parts.join("&")}`;
};

const bool = (value: boolean | undefined): string | undefined =>
  value === undefined ? undefined : String(value);

const sourceQuery = (from: EditorSource | undefined): Query =>
  from === undefined
    ? []
    : [
        [
          from._tag === "Contact" ? "contact" : from._tag === "Template" ? "template" : "duplicate",
          from.id,
        ],
      ];

/** Path below the base, starting with "/". */
const pathOf = (r: Route): string => {
  switch (r._tag) {
    case "Landing":
      return "/";
    case "Legal":
      return `/legal/${r.page}`;
    case "SignUp":
      return withQuery("/sign-up", [["invitation", r.invitation]]);
    case "SignIn":
      return withQuery("/sign-in", [["returnTo", r.returnTo]]);
    case "CheckEmail":
      return withQuery("/check-email", [["email", r.email]]);
    case "AuthLink":
      return `/auth/${r.kind}/${enc(r.token)}`;
    case "ResetPassword":
      return withQuery("/reset-password", [["token", r.token]]);
    case "AndroidDownload":
      return "/android";
    case "Share":
      return `/s/${enc(r.token)}`;
    case "McpConsent":
      return `/oauth/consent/${enc(r.consentId)}`;
    case "Invitation":
      return `/invitations/${enc(r.token)}`;
    case "Error":
      return `/error/${kebab(r.kind)}`;
    case "Onboarding":
      return withQuery("/onboarding", [
        ["step", r.step === undefined ? undefined : String(r.step)],
      ]);
    case "Account":
      return `/account/${r.tab}`;
  }
  const w = `/w/${r.ws}`;
  switch (r._tag) {
    case "Dashboard":
      return w;
    case "Documents":
      return withQuery(`${w}/documents`, [
        ["text", r.query.text],
        ["status", r.query.status],
        ["kind", r.query.kind],
        ["contact", r.query.contact],
      ]);
    case "DocumentNew":
      return withQuery(`${w}/documents/new/${r.kind}`, sourceQuery(r.from));
    case "DocumentEdit":
      return `${w}/documents/${r.id}/edit`;
    case "Document":
      return withQuery(`${w}/documents/${r.id}`, [
        ["tab", r.tab === "preview" ? undefined : r.tab],
        ["dialog", r.dialog],
      ]);
    case "Templates":
      return `${w}/templates`;
    case "Template":
      return withQuery(`${w}/templates/${r.id}`, [
        ["tab", r.tab === "template" ? undefined : r.tab],
      ]);
    case "Expenses":
      return withQuery(`${w}/expenses`, [
        ["text", r.query.text],
        ["incomplete", bool(r.query.incomplete)],
      ]);
    case "ExpenseCapture":
      return `${w}/expenses/capture`;
    case "Expense":
      return withQuery(`${w}/expenses/${r.id}`, [
        ["mode", r.mode === "view" ? undefined : r.mode],
        ["attachment", r.attachment],
        ["job", r.job],
      ]);
    case "Contacts":
      return withQuery(`${w}/contacts`, [
        ["text", r.query.text],
        ["role", r.query.role],
        ["archived", bool(r.query.archived)],
      ]);
    case "Contact":
      return withQuery(`${w}/contacts/${r.id}`, [["mode", r.mode === "view" ? undefined : r.mode]]);
    case "PriceList":
      return withQuery(`${w}/price-list`, [["text", r.text]]);
    case "Reports":
      return withQuery(`${w}/reports/${kebab(r.report)}`, [["period", r.period]]);
    case "Settings":
      return `${w}/settings/${kebab(r.section)}`;
    case "More":
      return `${w}/more`;
  }
};

const parseQuery = (search: string): Map<string, string> | undefined => {
  const out = new Map<string, string>();
  if (search === "") return out;
  for (const part of search.split("&")) {
    if (part === "") continue;
    const eq = part.indexOf("=");
    const key = dec(eq < 0 ? part : part.slice(0, eq));
    const value = dec(eq < 0 ? "" : part.slice(eq + 1));
    if (key === undefined || value === undefined) return undefined;
    out.set(key, value);
  }
  return out;
};

/** Copies the present query keys onto `target` (absent keys stay absent). */
const pick = (q: Map<string, string>, keys: ReadonlyArray<string>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = q.get(key);
    if (value !== undefined) out[key] = value;
  }
  return out;
};

const parseBool = (value: string | undefined): boolean | string | undefined =>
  value === "true" ? true : value === "false" ? false : value;

const parseIntParam = (value: string | undefined): number | string | undefined =>
  value !== undefined && /^-?\d+$/.test(value) ? Number(value) : value;

const withDefined = (record: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (v !== undefined) out[k] = v;
  return out;
};

/** Raw route candidate from path segments; the Route schema validates ids, slugs and literals. */
const rawRoute = (segments: ReadonlyArray<string>, q: Map<string, string>): unknown => {
  const [a, b, c, d, ...rest] = segments;
  const n = segments.length;
  if (n === 0) return { _tag: "Landing" };
  if (a !== "w") {
    if (n === 2 && a === "legal") return { _tag: "Legal", page: b };
    if (n === 1 && a === "sign-up") return { _tag: "SignUp", ...pick(q, ["invitation"]) };
    if (n === 1 && a === "sign-in") return { _tag: "SignIn", ...pick(q, ["returnTo"]) };
    if (n === 1 && a === "check-email") return { _tag: "CheckEmail", ...pick(q, ["email"]) };
    if (n === 3 && a === "auth") return { _tag: "AuthLink", kind: b, token: c };
    if (n === 1 && a === "reset-password") return { _tag: "ResetPassword", ...pick(q, ["token"]) };
    if (n === 1 && a === "android") return { _tag: "AndroidDownload" };
    if (n === 2 && a === "s") return { _tag: "Share", token: b };
    if (n === 3 && a === "oauth" && b === "consent") return { _tag: "McpConsent", consentId: c };
    if (n === 2 && a === "invitations") return { _tag: "Invitation", token: b };
    if (n === 2 && a === "error") return { _tag: "Error", kind: unkebab(b ?? "", ERROR_KINDS) };
    if (n === 1 && a === "onboarding") {
      return withDefined({ _tag: "Onboarding", step: parseIntParam(q.get("step")) });
    }
    if (n === 2 && a === "account") return { _tag: "Account", tab: b };
    return undefined;
  }
  if (b === undefined) return undefined;
  const base = { ws: b };
  if (n === 2) return { _tag: "Dashboard", ...base };
  if (rest.length > 1) return undefined;
  const e = rest[0];
  switch (c) {
    case "documents": {
      if (n === 3) {
        return {
          _tag: "Documents",
          ...base,
          query: pick(q, ["text", "status", "kind", "contact"]),
        };
      }
      if (d === "new" && e !== undefined) {
        const from = q.has("contact")
          ? { _tag: "Contact", id: q.get("contact") }
          : q.has("template")
            ? { _tag: "Template", id: q.get("template") }
            : q.has("duplicate")
              ? { _tag: "Duplicate", id: q.get("duplicate") }
              : undefined;
        return withDefined({ _tag: "DocumentNew", ...base, kind: e, from });
      }
      if (e === "edit") return { _tag: "DocumentEdit", ...base, id: d };
      if (n === 4) {
        return {
          _tag: "Document",
          ...base,
          id: d,
          tab: q.get("tab") ?? "preview",
          ...pick(q, ["dialog"]),
        };
      }
      return undefined;
    }
    case "templates":
      if (n === 3) return { _tag: "Templates", ...base };
      if (n === 4) return { _tag: "Template", ...base, id: d, tab: q.get("tab") ?? "template" };
      return undefined;
    case "expenses":
      if (n === 3) {
        return {
          _tag: "Expenses",
          ...base,
          query: withDefined({ ...pick(q, ["text"]), incomplete: parseBool(q.get("incomplete")) }),
        };
      }
      if (n === 4 && d === "capture") return { _tag: "ExpenseCapture", ...base };
      if (n === 4) {
        return {
          _tag: "Expense",
          ...base,
          id: d,
          mode: q.get("mode") ?? "view",
          ...pick(q, ["attachment", "job"]),
        };
      }
      return undefined;
    case "contacts":
      if (n === 3) {
        return {
          _tag: "Contacts",
          ...base,
          query: withDefined({
            ...pick(q, ["text", "role"]),
            archived: parseBool(q.get("archived")),
          }),
        };
      }
      if (n === 4) return { _tag: "Contact", ...base, id: d, mode: q.get("mode") ?? "view" };
      return undefined;
    case "price-list":
      return n === 3 ? { _tag: "PriceList", ...base, ...pick(q, ["text"]) } : undefined;
    case "reports":
      return n === 4
        ? {
            _tag: "Reports",
            ...base,
            report: unkebab(d ?? "", REPORT_KINDS),
            ...pick(q, ["period"]),
          }
        : undefined;
    case "settings":
      return n === 4
        ? { _tag: "Settings", ...base, section: unkebab(d ?? "", SETTINGS_SECTIONS) }
        : undefined;
    case "more":
      return n === 3 ? { _tag: "More", ...base } : undefined;
    default:
      return undefined;
  }
};

const decodeRoute = Schema.decodeUnknownOption(Route);

const PUBLIC_TAGS: ReadonlySet<RouteTag> = new Set<RouteTag>([
  "Landing",
  "Legal",
  "SignUp",
  "SignIn",
  "CheckEmail",
  "AuthLink",
  "ResetPassword",
  "AndroidDownload",
  "Share",
  "McpConsent",
  "Invitation",
  "Error",
]);

/** Routes an App Link may open directly (magic and auth links, invitations, share links). */
const DEEP_LINK_TAGS: ReadonlySet<RouteTag> = new Set<RouteTag>([
  "AuthLink",
  "Invitation",
  "Share",
]);

const fromPath = (path: string, base: RouteBase): Option.Option<Route> => {
  const hash = path.indexOf("#");
  const noHash = hash < 0 ? path : path.slice(0, hash);
  const qi = noHash.indexOf("?");
  const pathname = qi < 0 ? noHash : noHash.slice(0, qi);
  const search = qi < 0 ? "" : noHash.slice(qi + 1);
  let rel: string;
  if (base === "/") {
    if (!pathname.startsWith("/")) return Option.none();
    rel = pathname;
  } else if (pathname === "/app" || pathname.startsWith("/app/")) {
    rel = pathname.slice("/app".length) || "/";
  } else {
    return Option.none();
  }
  const raw = rel.split("/").filter((s) => s !== "");
  const segments: Array<string> = [];
  for (const s of raw) {
    const decoded = dec(s);
    if (decoded === undefined) return Option.none();
    segments.push(decoded);
  }
  const q = parseQuery(search);
  if (q === undefined) return Option.none();
  const candidate = rawRoute(segments, q);
  return candidate === undefined ? Option.none() : decodeRoute(candidate);
};

export const Routes = {
  /** "/w/acme/documents/0193…?tab=payments"; defaults (tab preview, mode view) are omitted. */
  toPath: (r: Route, base: RouteBase): string => {
    const path = pathOf(r);
    return base === "/" ? path : `/app${path === "/" ? "/" : path}`;
  },
  /** None for an unknown path, a malformed id or slug, or a path outside `base`. */
  fromPath,
  /**
   * App Links (https or the app scheme): magic and auth links, invitations and share links only.
   * Anything else opens the app without a target (None).
   */
  fromDeepLink: (url: string): Option.Option<Route> => {
    const scheme = url.indexOf("://");
    if (scheme < 0) return Option.none();
    const protocol = url.slice(0, scheme).toLowerCase();
    const afterScheme = url.slice(scheme + 3);
    // https://host/path keeps the path; kvitbit://path treats the host part as the first segment.
    const path =
      protocol === "http" || protocol === "https"
        ? afterScheme.slice(afterScheme.search(/[/?#]|$/))
        : `/${afterScheme}`;
    const normalized = path === "" || path.startsWith("?") ? `/${path}` : path;
    const route = Option.orElse(fromPath(normalized, "/"), () => fromPath(normalized, "/app/"));
    return Option.filter(route, (r) => DEEP_LINK_TAGS.has(r._tag));
  },
  requires: (r: Route): "public" | "account" | "workspace" =>
    PUBLIC_TAGS.has(r._tag) ? "public" : "ws" in r ? "workspace" : "account",
};

// --- Navigation ----------------------------------------------------------------------------------

export type NavSection =
  | "dashboard"
  | "documents"
  | "templates"
  | "expenses"
  | "contacts"
  | "priceList"
  | "reports"
  | "settings"
  | "more";

/** The section a route belongs to; None outside the Workspace scope. */
export const sectionOf = (r: Route): Option.Option<NavSection> => {
  switch (r._tag) {
    case "Dashboard":
      return Option.some("dashboard");
    case "Documents":
    case "DocumentNew":
    case "DocumentEdit":
    case "Document":
      return Option.some("documents");
    case "Templates":
    case "Template":
      return Option.some("templates");
    case "Expenses":
    case "ExpenseCapture":
    case "Expense":
      return Option.some("expenses");
    case "Contacts":
    case "Contact":
      return Option.some("contacts");
    case "PriceList":
      return Option.some("priceList");
    case "Reports":
      return Option.some("reports");
    case "Settings":
      return Option.some("settings");
    case "More":
      return Option.some("more");
    default:
      return Option.none();
  }
};

/** Web navigation rail / drawer, in order. */
export const WEB_NAV: ReadonlyArray<NavSection> = [
  "dashboard",
  "documents",
  "templates",
  "expenses",
  "contacts",
  "priceList",
  "reports",
  "settings",
];

/** Mobile M3 navigation bar (screen 06): Home, Documents, Expenses, Contacts, More. */
export const MOBILE_NAV: ReadonlyArray<NavSection> = [
  "dashboard",
  "documents",
  "expenses",
  "contacts",
  "more",
];

/** Text key of a section's navigation label. */
export const navLabelKey = (section: NavSection): `shell.nav.${NavSection}` =>
  `shell.nav.${section}`;

/** The highlighted navigation item: sections without their own mobile tab live under More. */
export const activeSection = (r: Route, platform: "web" | "mobile"): Option.Option<NavSection> =>
  Option.map(sectionOf(r), (section) => {
    if (platform === "mobile") return MOBILE_NAV.includes(section) ? section : "more";
    return section === "more" ? "settings" : section;
  });

const DEFAULT_SETTINGS: SettingsSection = "issuingEntity";

/** The entry route of a section in a Workspace. `current` keeps report and settings context. */
export const sectionRoute = (
  section: NavSection,
  slug: WorkspaceSlug,
  current?: Route,
): Option.Option<WorkspaceRoute> => {
  switch (section) {
    case "dashboard":
      return Option.some({ _tag: "Dashboard", ws: slug });
    case "documents":
      return Option.some({ _tag: "Documents", ws: slug, query: {} });
    case "templates":
      return Option.some({ _tag: "Templates", ws: slug });
    case "expenses":
      return Option.some({ _tag: "Expenses", ws: slug, query: {} });
    case "contacts":
      return Option.some({ _tag: "Contacts", ws: slug, query: {} });
    case "priceList":
      return Option.some({ _tag: "PriceList", ws: slug });
    case "reports":
      return current?._tag === "Reports" ? Option.some({ ...current, ws: slug }) : Option.none(); // a period is required; callers pick one
    case "settings":
      return Option.some({
        _tag: "Settings",
        ws: slug,
        section: current?._tag === "Settings" ? current.section : DEFAULT_SETTINGS,
      });
    case "more":
      return Option.some({ _tag: "More", ws: slug });
  }
};

/**
 * Workspace switch (screen 06): the same section in the new Workspace when it exists (Documents
 * stays Documents, ids and filters are dropped), else its Dashboard. Non-Workspace routes go to
 * the new Workspace's Dashboard.
 */
export const switchWorkspace = (r: Route, slug: WorkspaceSlug): WorkspaceRoute =>
  Option.getOrElse(
    Option.flatMap(sectionOf(r), (section) => sectionRoute(section, slug, r)),
    (): WorkspaceRoute => ({ _tag: "Dashboard", ws: slug }),
  );

// --- Keyboard shortcuts (web) ---------------------------------------------------------------------

export type ShortcutAction = "openWorkspaceSwitcher";

export interface Shortcut {
  /** Ctrl on Windows/Linux, Cmd on macOS. */
  readonly mod: boolean;
  readonly shift: boolean;
  readonly key: string;
  readonly action: ShortcutAction;
}

/** Spec 8.6 and user-flows 2.3 name one shortcut: Ctrl/Cmd+K opens the Workspace switcher. */
export const SHORTCUTS: ReadonlyArray<Shortcut> = [
  { mod: true, shift: false, key: "k", action: "openWorkspaceSwitcher" },
];

export interface KeyChord {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** Matches a key event against `SHORTCUTS`; `mac` picks Cmd instead of Ctrl as the modifier. */
export const matchShortcut = (chord: KeyChord, mac: boolean): Option.Option<ShortcutAction> => {
  const mod = mac ? chord.metaKey && !chord.ctrlKey : chord.ctrlKey && !chord.metaKey;
  const found = SHORTCUTS.find(
    (s) =>
      s.key === chord.key.toLowerCase() &&
      s.mod === mod &&
      s.shift === chord.shiftKey &&
      !chord.altKey,
  );
  return Option.fromNullishOr(found?.action);
};
