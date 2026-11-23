# ui-port contracts: portable TEA presenters for Foldkit Web and Expo Mobile

Issue #20. Status: proposed design, ready for review. Owner of this file: envoy `ui-port-contracts`.

This spec defines `packages/ui-port`: the screen state, messages, pure transitions, typed commands, intents, forms, theme state and platform ports that both UI adapters share. `apps/web` (Foldkit 0.171, Effect 4.1 TEA) renders it with `@foldkit/ui` and `@ui-sdk/core`. `apps/mobile` (Expo, React Native, expo-router) renders the same programs with Material 3 components, and the same Expo build ships as the Android APK and the `/app/` PWA. Mobile has full feature parity (user decision 16 in `user-flows.md` section 6).

Inputs, and what each one fixes:

| Input | What it fixes here |
|---|---|
| `docs/design/core-ports.md` (#18), section 9.2 | ui-port depends on `@kvitbit/core/contract`, `@kvitbit/core/engines` and the HttpApi contract only. Views are `Schema` classes. Errors arrive as `CoreError`. `can(caller, action)` hides controls. The editor calls `VatMath.calculate` per keystroke and `preview` debounced. |
| `docs/design/user-flows.md` | 72 flow headings (1.1 to 10.10) and the mobile screen set M01 to M19. The brief says 62 flows; the file has 72, and section 9 traces all 72. |
| `screens.md` (screen-by-screen design dir) | The 25 composite screens 01 to 25 that section 8 gives presenters for. |
| ADR 0001, 0002, 0004 | Foldkit TEA on web, ALTCHA PoW v2 with a native RN solver, the sealed `Caller` and five shared errors. |
| Peer agreements with `http-mcp-contracts` (#19) | Routes, headers, pagination, binary transfer, theme endpoints. Section 10 lists them. |
| User requirement (Material 3 themes) | Custom palettes from Google Material Theme Builder JSON, seed colours, built-in presets, Android Dynamic Color, harmonized `paid`/`proforma`/`overdue` extended colours. Section 4. |

Effect spellings follow `effect@4.1.4` as used in `core-ports.md` (`Context.Service`, `Schema.TaggedError`, `Schema.Literals`). Foldkit spellings follow 0.171 as far as known; section 12 lists every name to confirm during implementation. None of them changes the design.

---

## 0. Decisions in one page

1. **One program shape for both adapters.** Every screen is a `Program<Model, Message>` with a pure `update` that returns `Next = { model, commands, intents }`. Commands are named Effects that always end in a Message. Intents are plain data (navigate, toast, confirm) handled by the portable Shell or the router.
2. **Presenters, not views.** Each program exports `present(model, ctx): ViewModel`, a pure function producing render-ready data: `Text` descriptors (i18n keys and params), formatted money with tabular hints, badges, enabled actions, field errors. Foldkit `view` and React Native components render only the ViewModel. They never read the Model or call the API.
3. **Errors are values.** Every Command folds its failure into a `UiError` and then a Message. There is one mapping from wire errors to UI behaviour (section 2.6).
4. **Server is the authority, engines give instant feedback.** Editors run `VatMath`, `Numbering`, `PaymentQr` and `StatutoryText` locally on each change and replace the local result with the server `preview` when it arrives.
5. **Pessimistic for money and numbers, optimistic for reversible flags.** Issue, send, cancel, correct, Final Invoice, Payments and Expense saves wait for the server. Lock, archive, share-link create and revoke, and list filter changes update at once and roll back on failure.
6. **Platform reach goes through ports.** Passkeys, ALTCHA solving, camera, files, uploads, share sheet, clipboard, connectivity, storage, deep links and dynamic colour are `Context.Service` ports in ui-port. Adapters provide Layers. ui-port never imports DOM, React or React Native.
7. **Offline is a mobile capture queue only** (decision Q9). Expense photo and PDF captures are queued on the device with a pinned Workspace, a stable Idempotency-Key and content-hashed attachments, and replay exactly once. Every other write needs connectivity.
8. **Theme is portable state.** `ThemeState` resolves an effective Material 3 scheme from Android dynamic colour, the account theme, the workspace theme, or the Kvitbit default, in that order (agreement AG-HTTP-THEME). ui-port parses Material Theme Builder JSON with a Schema and resolves seeds through a `ThemeEngine` port, so it bundles no colour library.

---

## 1. Package shape and dependency rules

```
packages/ui-port
├─ src/tea/            Program, Next, Command, Intent, Subscription, Remote, Paged, Form, Text
├─ src/api/            KvitbitApi service, call helpers, UiError mapping, request headers
├─ src/ports/          platform ports (section 5)
├─ src/routes/         Route union, toPath/fromPath, deep-link parsing
├─ src/theme/          ThemeState, MaterialThemeJson parser, ThemeEngine port, default theme data
├─ src/format/         money, dates, numbers (Intl only), Text helpers
├─ src/shell/          AppShell program: session, workspace, overlay, capture queue, theme
├─ src/screens/        one folder per presenter (section 8)
└─ src/testing/        TestUiServices layer, fake ports, program test harness
```

Entry points:

| Entry point | Contents | Consumers |
|---|---|---|
| `@kvitbit/ui-port` | TEA kernel, Route, UiError, Text, format, Shell program, every presenter | apps/web, apps/mobile |
| `@kvitbit/ui-port/ports` | Port tags and their interfaces only | adapters that implement ports |
| `@kvitbit/ui-port/theme` | ThemeState, parser, ThemeEngine tag, `KvitbitDefaultTheme` data | adapters, server tests (default theme snapshot) |
| `@kvitbit/ui-port/testing` | `TestUiServices`, fake ports, `runProgram` harness | tests |

Allowed imports, enforced by `dependency-cruiser` (or ESLint `no-restricted-imports`) in CI:

| Allowed | Forbidden |
|---|---|
| `effect` (4.1.4), `@kvitbit/core/contract`, `@kvitbit/core/engines`, `@kvitbit/api-contract` | `@kvitbit/core` (server modules), anything under `react`, `react-native`, `expo*`, `@foldkit/*`, `@ui-sdk/*`, `better-auth*`, DOM lib types (`tsconfig` sets `"lib": ["ES2023"]` with no `DOM`), `@material/material-color-utilities` |

`effect` is implied by the brief: core's contract is built on it. The API contract package name is `@kvitbit/api-contract` (`packages/api-contract`), fixed in agreement AG-UI-2. The brief's `@kvitbit/contracts` refers to the same package.

Copy and i18n: ui-port emits `Text` descriptors, never strings. The catalogues (cs and en) live in a separate `packages/i18n` that both adapters load. ui-port exports the closed `MessageKey` union so a missing key fails type checking. `IssueCode` from core is a subset of `MessageKey`.

---

## 2. Portable TEA architecture

### 2.1 Kernel types

```ts
// @kvitbit/ui-port/tea/Program.ts
import { Effect, Schema, Stream } from "effect"

/** A named effect that always ends in exactly one Message. Errors are folded in, never thrown. */
export interface Command<Msg> {
  readonly name: string                                  // stable; tests and devtools key on it
  readonly key?: string                                  // same key supersedes an earlier in-flight command
  readonly effect: Effect.Effect<Msg, never, UiServices>
}

/** Long-lived input: timers, connectivity, system theme, deep links, upload progress. */
export interface Subscription<Msg> {
  readonly key: string                                   // adapters diff by key: start new, stop removed
  readonly stream: Stream.Stream<Msg, never, UiServices>
}

/** What update returns. Intents are data the Shell or the router handles. */
export interface Next<Model, Msg> {
  readonly model: Model
  readonly commands: ReadonlyArray<Command<Msg>>
  readonly intents: ReadonlyArray<Intent<Msg>>
}

export interface Program<Model, Msg, Flags, VM> {
  readonly id: ScreenId                                  // e.g. "documents.editor"
  readonly Model: Schema.Codec<Model, unknown>           // encodes for SSR hydration and RN state restore
  readonly Message: Schema.Codec<Msg, unknown>           // encodes for devtools, replay, tests
  readonly Flags: Schema.Codec<Flags, unknown>           // route params and server-provided initial data
  readonly init: (flags: Flags, ctx: ScreenContext) => Next<Model, Msg>
  readonly update: (model: Model, msg: Msg, ctx: ScreenContext) => Next<Model, Msg>
  readonly subscriptions: (model: Model, ctx: ScreenContext) => ReadonlyArray<Subscription<Msg>>
  readonly present: (model: Model, ctx: ScreenContext) => VM
}

export const Next = {
  of: <M, Msg>(model: M): Next<M, Msg> => ({ model, commands: [], intents: [] }),
  // with(model, { commands, intents }), map(next, wrapModel, wrapMsg) for nesting
}
```

`ScreenContext` is a read-only snapshot the Shell passes to every call. It keeps `update` pure: anything time-, session- or device-dependent comes in through it or through a Message.

```ts
export interface ScreenContext {
  readonly session: SessionSnapshot          // section 2.9
  readonly today: IsoDate                    // Europe/Prague calendar date, updated by a Shell midnight subscription
  readonly locale: Locale                    // UI locale
  readonly platform: "web" | "android" | "pwa"
  readonly formFactor: "compact" | "medium" | "expanded" // M3 window size classes; drives present(), not logic
  readonly online: boolean
  readonly config: ServerConfig              // GET /api/v1/config: upload limits, botProtection, features
}
```

Rules:

- T1. `update` is total and pure. No `Date.now()`, no random ids, no I/O. Request keys are minted by a Command (`Ids.requestKey`) and arrive in a Message, so a retry reuses the key stored in the Model.
- T2. Every Command ends in a Message, including failures and cancellation (`Interrupted` is folded into the command's result Message as `UiError.Cancelled`). A screen never waits on a Command that cannot report back.
- T3. A Command with a `key` supersedes the in-flight Command with the same key (latest wins). Debounced previews, searches and list reloads use keys. Results also carry a sequence number in the Model so a late result from a superseded run is ignored even if an adapter could not interrupt it.
- T4. Model and Message are Schema codecs. `BigDecimal` encodes as a decimal string, ids stay branded strings. This is what lets Foldkit hydrate SSR state and Expo restore a screen after process death.
- T5. `present` is pure and cheap. It may call engines (VatMath for totals display) but must not allocate commands.

### 2.2 Messages

Each program declares its Message as a `Schema.Union` of `Schema.TaggedStruct`s. Naming convention, so traces read the same on both platforms:

| Kind | Tag pattern | Examples |
|---|---|---|
| User event | past-tense verb on a control | `ClickedIssue`, `ChangedLine`, `SubmittedForm`, `SelectedRow`, `PulledToRefresh` |
| Command result | `Got<Thing>` carrying `ApiResult<A>` | `GotDocument`, `GotPreview`, `GotIssueResult` |
| Lifecycle | `Entered`, `Resumed`, `Left`, `RouteParamsChanged` | `Resumed` fires when the app returns to the foreground |
| Intent reply | `Confirmed { id, input }`, `ConfirmDismissed { id }`, `ToastActionClicked { id }` | |
| Timer | `Debounced<Thing> { seq }`, `Ticked` | `DebouncedPreview { seq }`, `CooldownTicked` |

```ts
export type ApiResult<A> =
  | { readonly _tag: "Ok"; readonly value: A; readonly meta: ResponseMeta }
  | { readonly _tag: "Err"; readonly error: UiError }

export interface ResponseMeta {
  readonly etag: number | null           // parsed from ETag "<revision>"
  readonly replayed: boolean             // Idempotent-Replayed: true
}
```

### 2.3 Commands against the API

```ts
// @kvitbit/ui-port/api/KvitbitApi.ts
import { Context, Effect } from "effect"
import { HttpApiClient } from "effect/http-api"   // spelling to confirm, section 12
import { Api } from "@kvitbit/api-contract"

export class KvitbitApi extends Context.Service<
  KvitbitApi,
  Effect.Success<ReturnType<typeof HttpApiClient.make<typeof Api>>>
>()("ui-port/KvitbitApi") {}

/** The one way a presenter talks to the server. */
export const call = <A, E, Msg>(
  name: string,
  run: (api: KvitbitApi["Service"]) => Effect.Effect<A, E, never>,
  toMsg: (result: ApiResult<A>) => Msg,
  options?: { readonly key?: string; readonly timeout?: Duration.DurationInput },
): Command<Msg> => ({
  name,
  key: options?.key,
  effect: KvitbitApi.pipe(
    Effect.flatMap(run),
    Effect.timeout(options?.timeout ?? "20 seconds"),
    Effect.map((value) => toMsg({ _tag: "Ok", value, meta: currentMeta() })),
    Effect.catch((e) => Effect.succeed(toMsg({ _tag: "Err", error: UiError.fromUnknown(e) }))),
  ),
})
```

Headers. The HttpApi endpoints declare their headers (agreement AG-UI-1), so presenters pass them as typed arguments:

| Header | Source in ui-port | Applies to |
|---|---|---|
| `If-Match: "<revision>"` | the `revision` of the view the form was loaded from, kept in the Model | every `expectedRevision` operation (core rule C6). Never `*`. |
| `Idempotency-Key` | a UUIDv7 minted by `Ids.requestKey` when the intent starts (the first submit), stored in the Model, reused on every retry of that intent, cleared on success or when the user edits the form | every `requestKey` operation (core rule C6), and the offline expense queue |
| `X-Altcha` | the solved ALTCHA payload from `BotProof.solve` | the protected Better Auth POSTs (AG-UI-2) |
| `Accept-Language` | `ctx.locale` | every request; the account preference wins on the server (P8) |
| credentials | not ui-port's concern: the adapter's `HttpClient` layer adds the cookie (web) or bearer (Expo) | all |

Better Auth routes under `/api/auth` are not part of the HttpApi. ui-port reaches them through the `AuthClient` port (section 5.1), whose adapters wrap the Better Auth web and Expo clients. Everything else goes through `KvitbitApi`.

### 2.4 Remote data, lists and selection

```ts
export type Remote<A> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Loading"; readonly stale: Option.Option<A> }      // stale: show old data dimmed
  | { readonly _tag: "Ready"; readonly value: A; readonly refreshing: boolean }
  | { readonly _tag: "Failed"; readonly error: UiError; readonly stale: Option.Option<A> }

export interface Paged<A, Q> {
  readonly query: Q                               // decoded filter Schema, mirrored in the URL
  readonly items: ReadonlyArray<A>
  readonly nextCursor: string | null
  readonly status: "loading" | "ready" | "loading_more" | "refreshing" | "failed"
  readonly error: Option.Option<UiError>
  readonly seq: number                            // T3: ignore results for an older query
}

export interface Selection<Id> {
  readonly focused: Option.Option<Id>             // master-detail on expanded, keyboard focus on web
  readonly checked: ReadonlyArray<Id>             // bulk actions (export, archive)
}
```

Pagination follows AG-UI-1: `cursor` plus `limit` (1 to 100, default 50, ui-port asks for 50). The cursor is bound to the filter hash, so any filter change drops the cursor, bumps `seq` and reloads from the first page. `Invalid{page.cursor_mismatch}` is treated as a stale list: drop the cursor and reload silently. Sorting is fixed per list in v1; ui-port offers no sort control.

Every list presenter derives one `ListState` for its ViewModel, which adapters render the same way on both platforms:

```ts
export type ListState =
  | { readonly _tag: "Loading" }                                  // skeleton rows, no spinner flash under 300 ms
  | { readonly _tag: "Empty"; readonly reason: "no_records" | "no_matches"; readonly cta: Option.Option<ActionVM> }
  | { readonly _tag: "Error"; readonly error: ErrorVM }           // inline, with Retry
  | { readonly _tag: "Ready"; readonly rows: ReadonlyArray<RowVM>; readonly more: "none" | "available" | "loading" }
```

`Empty.no_records` shows the first-use call to action (for example "Add your first Contact"); `Empty.no_matches` shows "Clear filters".

### 2.5 Intents: navigation, toasts, confirmations

Intents are data. The Shell program (section 2.9) handles toasts and confirmations in its own Model, so the overlay behaviour is itself portable; adapters only render the Shell's overlay ViewModel. Navigation intents go to the adapter's router.

```ts
export type Intent<Msg> =
  | { readonly _tag: "Navigate"; readonly to: Route; readonly mode: "push" | "replace" }
  | { readonly _tag: "NavigateBack"; readonly fallback: Route }
  | { readonly _tag: "Toast"; readonly toast: Toast<Msg> }
  | { readonly _tag: "Confirm"; readonly confirm: Confirmation }
  | { readonly _tag: "SessionInvalid" }                       // 401 anywhere: Shell signs out locally and routes to sign-in
  | { readonly _tag: "WorkspaceLost"; readonly workspace: WorkspaceId } // 404 on {ws}: Shell refreshes listMine
  | { readonly _tag: "Refresh"; readonly scope: RefreshScope }  // e.g. documents list after an issue in a dialog

export interface Toast<Msg> {
  readonly id: string
  readonly tone: "info" | "success" | "warning" | "error"
  readonly text: Text
  readonly action: Option.Option<{ readonly label: Text; readonly msg: Msg }> // e.g. "Undo", "View", "Retry"
  readonly duration: "short" | "long" | "until_dismissed"   // 4 s, 10 s, sticky
}

export interface Confirmation {
  readonly id: ConfirmId                     // closed literal union per screen, e.g. "document.unlock"
  readonly title: Text
  readonly body: Text
  readonly confirmLabel: Text
  readonly tone: "primary" | "destructive"
  readonly input: Option.Option<
    | { readonly _tag: "Reason"; readonly label: Text; readonly minLength: number } // unlock, cancel, payment removal
    | { readonly _tag: "TypeToConfirm"; readonly expected: string }               // workspace close, account delete
  >
}
```

The Shell answers a confirmation by sending the owning screen `Confirmed { id, input }` or `ConfirmDismissed { id }`. Because the reply is a Message, the screen's `update` stays the only place that decides what happens next.

Rendering: web shows confirmations as `@foldkit/ui` modal dialogs and toasts as an M3 snackbar region with `aria-live="polite"` (errors `assertive`). Mobile shows M3 dialogs (full-screen dialog on compact for `TypeToConfirm`) and an M3 snackbar above the navigation bar. Only one snackbar is visible; the Shell queues the rest and drops duplicates with the same `id`.

### 2.6 UiError and the one error mapping

```ts
import { NotFound, Forbidden, Invalid, Conflict, Unavailable } from "@kvitbit/core/contract"
import { Unauthorized, PreconditionFailed, PreconditionRequired, RateLimited, PayloadTooLarge, InvalidBotProof }
  from "@kvitbit/api-contract"

export type UiError =
  | NotFound | Forbidden | Invalid | Conflict | Unavailable          // core, wire-visible (ADR 0004)
  | Unauthorized | PreconditionFailed | PreconditionRequired           // HTTP edge (AG-UI-1, P7)
  | RateLimited | PayloadTooLarge | InvalidBotProof
  | { readonly _tag: "Offline" }                                      // no response reached the client
  | { readonly _tag: "Timeout" }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Unexpected"; readonly status: number | null; readonly requestId: string | null } // 5xx, decode failure
```

| Error | Default behaviour (screens may refine, never contradict) |
|---|---|
| `Unauthorized` 401 | `SessionInvalid` intent. Shell keeps the current route as `returnTo` (flow 1.3 deep-link branch). |
| `Forbidden` 403 | Inline "You don't have access to this action" on the control's area; the control is hidden next time because `can` already disagrees only when scopes changed. Never a toast loop. |
| `NotFound` 404 on a detail route | Error page variant `not_found` (screen 03). On the `{ws}` segment: `WorkspaceLost` intent, then "No access" page. |
| `Invalid` 422 | Field errors: each issue's `path` maps onto the form's field paths (section 2.7). Issues with no matching field go to a form-level error summary. |
| `Conflict{revision_changed}` 409, `PreconditionFailed` 412 | One `StaleRevision` state (AG-UI-1): keep the user's draft, show "Changed elsewhere. Reload to see the latest, then reapply your edits." with Reload and a diff of changed fields when the reloaded view arrives. |
| `PreconditionRequired` 428 | Defect in ui-port (it always sends If-Match). Logged, shown as `Unexpected`. |
| `Conflict{document_locked}` | Banner "Locked. Unlock to edit" with Unlock for owner/admin. |
| `Conflict{illegal_transition \| duplicate}` | Inline error with the `detail` IssueCode text (for example "Number already used"). |
| `Conflict{idempotency_mismatch}` | Defect: the client changed a payload under a reused key. Clear the key, show `Unexpected`. |
| `Unavailable` 503 | Retry banner naming the dependency ("ARES is not responding", "CNB rates unavailable") and `retryAfterSeconds` countdown. Editors keep working locally. |
| `RateLimited` 429 | Disable the control until `Retry-After`; ALTCHA screens require a fresh solution. |
| `PayloadTooLarge` 413 | Mapped to `Invalid{attachment.too_large}` on the file row. |
| `InvalidBotProof` 400 | Restart the ALTCHA solver, keep form values (flow 1.2 branch). |
| `Offline` | Inline "You're offline" with Retry; the Shell shows a persistent offline chip. Capture queue jobs wait instead of failing. |
| `Timeout`, `Unexpected` | Generic error with Retry and the request id for support. |

### 2.7 Forms and validation

Forms keep the raw text the user typed (so "1 234,5" stays as typed in Czech) and decode it to the core input Schema on submit and on blur. Validation runs on both sides with the same codes: client issues come from decoding the form Schema, server issues from `Invalid.issues`.

```ts
export interface Form<Draft, Input> {
  readonly draft: Draft                                     // raw values, Schema-encodable
  readonly touched: ReadonlyArray<FieldPath>
  readonly clientIssues: ReadonlyArray<FieldIssue>          // from decoding draft -> Input
  readonly serverIssues: ReadonlyArray<FieldIssue>          // from the last Invalid; cleared per path on change
  readonly submit:
    | { readonly _tag: "Idle" }
    | { readonly _tag: "Submitting"; readonly requestKey: Option.Option<RequestKey> }
    | { readonly _tag: "Failed"; readonly error: UiError; readonly requestKey: Option.Option<RequestKey> }
  readonly baseRevision: Option.Option<number>              // for If-Match; None on create
}

export type FieldPath = string                               // "lines.2.unitPrice", core paths joined with "."
export interface FieldIssue { readonly path: FieldPath; readonly code: MessageKey; readonly params?: Record<string, string> }

export interface FormSpec<Draft, Input> {
  /** Effect Schema from draft text to the core input. Locale-aware decimals use DecimalText(locale). */
  readonly schema: (locale: Locale) => Schema.Codec<Input, Draft>
  /** The same schema as a Standard Schema V1 validator, for adapter widgets that speak Standard Schema. */
  readonly standard: (locale: Locale) => StandardSchemaV1<Draft, Input>  // Schema.toStandardSchemaV1(schema(locale))
  /** Client-only rules that the server also enforces, so the user sees them before submit. */
  readonly refine?: (input: Input, ctx: ScreenContext) => ReadonlyArray<FieldIssue>
}

export const Form: {
  readonly init: <D, I>(draft: D, baseRevision?: number) => Form<D, I>
  readonly change: <D, I>(form: Form<D, I>, path: FieldPath, value: unknown) => Form<D, I> // clears server issue at path
  readonly validate: <D, I>(form: Form<D, I>, spec: FormSpec<D, I>, ctx: ScreenContext) =>
    Either.Either<I, Form<D, I>>
  readonly applyServer: <D, I>(form: Form<D, I>, error: Invalid) => Form<D, I>
  readonly issuesAt: (form: Form<any, any>, path: FieldPath, opts: { readonly showUntouched: boolean }) =>
    ReadonlyArray<FieldIssue>
}
```

Rules:

- F1. Client issue codes reuse core `IssueCode` values where the rule is the same (`ico.checksum`, `document.lines_required`, `document.due_before_issue`). ui-only codes use the `form.` prefix (`form.required`, `form.decimal_invalid`, `form.email_invalid`).
- F2. Errors show on blur or after the first submit, never while typing the first value.
- F3. Submit decodes the draft. On failure it marks all fields touched and focuses the first error (`FocusField` is part of the ViewModel; adapters move focus and announce it).
- F4. Server issues map by exact path, then by the longest matching prefix (`lines.2` for an issue on `lines.2.vat` when the vat control is hidden), else to the form summary.
- F5. Decimal fields use `DecimalText(locale)`: accepts `,` or `.` as decimal separator, spaces and NBSP as group separators, at most the field's scale. Output is `BigDecimal`.
- F6. IČO fields validate the checksum locally (mod 11) before an ARES call, matching core's `ico.checksum`.

### 2.8 Live calculation with the engines

The Document Editor (screen 10), Template editor (12), Expense editor (14), Numbering settings (19) and Payment dialogs (11) use the pure engines from `@kvitbit/core/engines` inside `update` and `present`:

| Engine call | Where | Behaviour |
|---|---|---|
| `VatMath.calculate` | every line, currency, date, `pricesIncludeVat` change in editors | instant totals and rate buckets; uses the last known FX (`preview` result, manual rate, or FX lookup) |
| `VatMath.rateFor` | VAT treatment picker | shows "21 %" beside "Standard" for the tax point |
| `VatMath.splitAdvance` | Proforma settlement dialog | shows the Payment Tax Document split before recording a vat_payer Proforma payment |
| `Numbering.parsePattern`, `format`, `periodKey` | Numbering Series editor; "will be numbered" hint in Issue dialog | next three numbers, pattern errors as `numbering.pattern_invalid` |
| `Numbering.variableSymbol` | editor bank panel | default variable symbol preview |
| `PaymentQr.forDocument`, `toSvg` | editor preview panel, document detail | QR preview; `Invalid{qr.*}` shown as a warning, not a blocker, until issue |
| `StatutoryText.title`, `notes` | editor preview panel | live document title and footer notes for the Tax Regime and treatments |

The server stays authoritative (core 9.2). The editor sends `POST .../documents/preview` with key `preview` 400 ms after the last change (T3), and when the result arrives it replaces the local breakdown, FX, statutory notes and QR. If local and server totals differ, the ViewModel shows the server value and the Model records `calcDrift: true` for telemetry (a drift means an engine version mismatch between bundles).

FX rules in the editor (flow 3.11, decision Q4):

- CZK document: no FX panel.
- Non-CZK with a past or today's taxable supply date: FX comes from `preview` (CNB fixing for that date, Friday's for a weekend).
- `Unavailable{exchange_rates}` or currency not on the CNB list: the panel offers a manual rate. A manual rate is marked "manual" in the panel. Core needs a `DocumentInput.fx` field for this (gap G3, section 11).
- Future taxable supply date: manual rate required before issue (Q4).

### 2.9 The Shell program

`AppShell` is the root program on both platforms. It owns everything that outlives a screen.

```ts
export interface ShellModel {
  readonly session: Remote<Session>                    // from AuthClient.getSession + GET /me/preferences
  readonly workspaces: Remote<ReadonlyArray<WorkspaceSummary>>
  readonly active: Option.Option<ActiveWorkspace>      // id, slug, name, role, scopes, taxRegime
  readonly route: Route
  readonly returnTo: Option.Option<Route>              // set by SessionInvalid and by deep links before sign-in
  readonly overlay: { readonly toasts: ReadonlyArray<Toast<ShellMsg>>; readonly confirm: Option.Option<PendingConfirm> }
  readonly online: boolean
  readonly theme: ThemeState                           // section 4
  readonly captureQueue: CaptureQueueModel            // section 6 (android and pwa only; empty on web)
  readonly switcher: { readonly open: boolean; readonly query: string }
}

export interface SessionSnapshot {
  readonly user: Option.Option<{ readonly id: UserId; readonly email: string; readonly name: string; readonly emailVerified: boolean }>
  readonly member: Option.Option<MemberCaller>        // built client-side for can(); display only, server re-checks
}
```

`member` is a `MemberCaller`-shaped value the Shell builds from the active Workspace's role and the session (`scopes: "all"`, `channel: "web" | "mobile"`). It exists only so presenters can call `can(member, action)` from `/contract`; the server enforces the same table. Presenters never branch on `role` directly.

Routing of child programs: the Shell maps `Route` to a screen program, wraps its messages as `ScreenMsg { msg }`, lifts its `Next` with `Next.map`, and forwards intents. On web, one screen program is active at a time (plus dialogs it embeds). On mobile, expo-router keeps a stack, so each stacked screen keeps its own program instance (section 7.2); the Shell still owns session, overlay, theme and the queue.

Subscriptions the Shell always runs: `Connectivity.changes`, `AppLifecycle.changes` (refresh session and the active screen on resume), `SystemTheme.changes`, `DeepLinks.incoming`, a Prague-midnight tick for `today`, and the capture queue drain (section 6).

### 2.10 Routes

```ts
export const Route = Schema.Union([
  // Public
  Schema.TaggedStruct("Landing", {}),
  Schema.TaggedStruct("Legal", { page: Schema.Literals(["terms", "privacy"]) }),
  Schema.TaggedStruct("SignUp", { invitation: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("SignIn", { returnTo: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("CheckEmail", { email: Schema.String }),
  Schema.TaggedStruct("AuthLink", { kind: Schema.Literals(["verify", "magic", "reset"]), token: Schema.String }),
  Schema.TaggedStruct("ResetPassword", { token: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("AndroidDownload", {}),
  Schema.TaggedStruct("Share", { token: ShareToken }),
  Schema.TaggedStruct("McpConsent", { consentId: Schema.String }),
  Schema.TaggedStruct("Invitation", { token: Schema.String }),
  Schema.TaggedStruct("Error", { kind: Schema.Literals(["not_found", "no_access", "server", "offline"]) }),
  // Account scope
  Schema.TaggedStruct("Onboarding", { step: Schema.optional(Schema.Int) }),
  Schema.TaggedStruct("Account", { tab: Schema.Literals(["profile", "appearance", "security", "sessions", "danger"]) }),
  // Workspace scope: every route below carries ws (the Workspace slug)
  Schema.TaggedStruct("Dashboard", { ws: WorkspaceSlug }),
  Schema.TaggedStruct("Documents", { ws: WorkspaceSlug, query: DocumentListQuery }),
  Schema.TaggedStruct("DocumentNew", { ws: WorkspaceSlug, kind: Schema.Literals(["invoice", "proforma"]),
    from: Schema.optional(Schema.Union([ContactRef, TemplateRef, DuplicateRef])) }),
  Schema.TaggedStruct("DocumentEdit", { ws: WorkspaceSlug, id: DocumentId }),
  Schema.TaggedStruct("Document", { ws: WorkspaceSlug, id: DocumentId,
    tab: Schema.Literals(["preview", "payments", "share", "history"]), dialog: Schema.optional(DocumentDialog) }),
  Schema.TaggedStruct("Templates", { ws: WorkspaceSlug }),
  Schema.TaggedStruct("Template", { ws: WorkspaceSlug, id: Schema.Union([TemplateId, Schema.Literal("new")]),
    tab: Schema.Literals(["template", "schedule", "runs"]) }),
  Schema.TaggedStruct("Expenses", { ws: WorkspaceSlug, query: ExpenseListQuery }),
  Schema.TaggedStruct("ExpenseCapture", { ws: WorkspaceSlug }),
  Schema.TaggedStruct("Expense", { ws: WorkspaceSlug, id: Schema.Union([ExpenseId, Schema.Literal("new")]),
    mode: Schema.Literals(["view", "edit"]), attachment: Schema.optional(AttachmentId), job: Schema.optional(CaptureJobId) }),
  Schema.TaggedStruct("Contacts", { ws: WorkspaceSlug, query: ContactListQuery }),
  Schema.TaggedStruct("Contact", { ws: WorkspaceSlug, id: Schema.Union([ContactId, Schema.Literal("new")]),
    mode: Schema.Literals(["view", "edit"]) }),
  Schema.TaggedStruct("PriceList", { ws: WorkspaceSlug, text: Schema.optional(Schema.String) }),
  Schema.TaggedStruct("Reports", { ws: WorkspaceSlug, report: ReportTab, period: Period }),
  Schema.TaggedStruct("Settings", { ws: WorkspaceSlug, section: SettingsSection }),
  Schema.TaggedStruct("More", { ws: WorkspaceSlug }),          // mobile navigation bar tab; web redirects to Settings
])
export type Route = typeof Route.Type

export const Routes: {
  readonly toPath: (r: Route, base: "/" | "/app/") => string   // "/w/acme/documents/0193…?tab=payments"
  readonly fromPath: (path: string, base: "/" | "/app/") => Option.Option<Route>
  readonly fromDeepLink: (url: string) => Option.Option<Route>  // App Links: magic link, invitation, share link
  readonly requires: (r: Route) => "public" | "account" | "workspace"
}
```

Paths are the same on web (base `/`) and the PWA (base `/app/`); expo-router file names mirror them (section 7.2). Query state (list filters, report period, tabs) lives in the route so links and back navigation restore it. `Routes.toPath(Routes.fromPath(p)) == p` for every canonical path is a property test.

The `ws` segment is the Workspace slug, as `user-flows.md` rule 1 asks. The Shell resolves slug to `WorkspaceId` from `listMine`; API calls always use the id. A slug the user is not a Member of renders "No access" (screen 03).

### 2.11 Optimistic updates

| Operation | Strategy | Rollback |
|---|---|---|
| Lock document | optimistic: badge flips at once | restore and toast the error |
| Unlock document | pessimistic (reason dialog, owner/admin) | n/a |
| Share link create, revoke | optimistic on the panel; URL shown when the server answers | restore panel state |
| Archive Contact, Price List Item, Template | optimistic removal from the list with an "Undo" toast that re-saves | reinsert at the old index |
| List filters, tabs, selection | local, then reload with seq (T3) | n/a |
| Expense capture | queued locally (section 6); row shows "Uploading" or "Queued" | job stays in the queue with Retry |
| Issue, send, cancel, Credit Note, Final Invoice, Payment record and remove, Expense save, settings saves, team changes | pessimistic: button shows progress, form stays editable but submit is disabled | n/a |

Optimistic state is modelled, not hidden: the Model keeps `pending: ReadonlyArray<PendingOp>` with the before-image, so `present` can show a subtle "Saving" marker and the rollback is a pure transition.

### 2.12 Formatting and the ViewModel vocabulary

```ts
export type Text =
  | { readonly _tag: "Key"; readonly key: MessageKey; readonly params?: Record<string, TextParam> }
  | { readonly _tag: "Raw"; readonly value: string }                  // user data: names, notes, numbers

export interface MoneyVM {
  readonly text: string            // "12 345,50 Kč" (cs) / "CZK 12,345.50" (en), Intl.NumberFormat
  readonly sign: "positive" | "negative" | "zero"
  readonly tabular: true           // adapters set font-variant-numeric / fontVariant: ["tabular-nums"]
  readonly currency: CurrencyCode
}

export interface BadgeVM {
  readonly kind: "draft" | "issued" | "sent" | "viewed" | "partially_paid" | "paid" | "overdue" | "credited"
    | "cancelled" | "locked" | "proforma" | "incomplete" | "queued" | "failed"
  readonly text: Text
  readonly role: "neutral" | "primary" | "error" | ExtendedRole       // ExtendedRole = "paid" | "proforma" | "overdue" | "draft"
}

export interface ActionVM<Msg> {
  readonly id: string
  readonly label: Text
  readonly msg: Msg
  readonly emphasis: "primary" | "secondary" | "tertiary" | "destructive"
  readonly state: "enabled" | "busy" | { readonly _tag: "disabled"; readonly why: Text }
}
```

`format` uses only `Intl` (available in browsers and in Hermes on Android). Money formatting never rounds a value the server did not round: the display scale is 2, and amounts arrive already rounded per bucket.

---

## 3. Session, authentication and bot protection flow

Auth screens (02, 05, 22) talk to Better Auth through the `AuthClient` port and solve ALTCHA through the `BotProof` port. The ALTCHA sequence is shared by sign up, sign in after failures, magic link and password reset (AG-UI-2):

```
Entered ─► GET /api/v1/bot-protection/challenges/{scope}
             ├─ 204 (NoopBotProtection) ─► proof = None, submit enabled
             └─ 200 challenge ─► BotProof.solve (background, progress stream)
                                   └─ BotProofSolved { payload } ─► submit enabled
SubmittedForm ─► AuthClient.signUpEmail(input, { altcha: payload })   // header X-Altcha
   ├─ Ok ─► Navigate CheckEmail
   ├─ InvalidBotProof ─► restart solver, keep values (flow 1.2)
   └─ Invalid ─► field errors (weak or breached password)
Challenge expiry (challenge.expires) ─► refetch and re-solve before submit
```

```ts
export type BotProofState =
  | { readonly _tag: "NotRequired" }                         // 204, or install reports botProtection "none"
  | { readonly _tag: "Fetching" }
  | { readonly _tag: "Solving"; readonly progress: number }  // 0..1; mobile shows it (flow 1.2 branch)
  | { readonly _tag: "Solved"; readonly payload: string; readonly expiresAt: string }
  | { readonly _tag: "Failed"; readonly error: UiError }
```

The submit button shows "Verifying you're human" while `Solving` and becomes enabled on `Solved` or `NotRequired`. The solver starts on `Entered`, not on submit, so a typical sign-up never waits.

Sign in requires ALTCHA only after repeated failures (flow 1.3). The presenter starts in `NotRequired` for sign in and switches to fetching a `sign_in` challenge when the server answers `RateLimited` or an `Invalid` issue with code `auth.bot_proof_required`.

---

## 4. Material 3 theme

### 4.1 Sources and precedence

Agreement AG-HTTP-THEME fixes the wire shapes, all exported by `@kvitbit/api-contract` (`packages/api-contract/src/theme.ts`):

```ts
export type ThemeSource =
  | { readonly _tag: "Preset"; readonly id: ThemePresetId }               // closed union; ThemePresets maps id -> { seed, contrast? }
  | { readonly _tag: "Seed"; readonly seed: Hex }                         // "#RRGGBB"
  | { readonly _tag: "MaterialThemeBuilder"; readonly json: unknown }      // raw material-theme.json, at most 64 KB
export type ThemeMode = "system" | "light" | "dark"
export type ThemeStyle = "elegant" | "cozy"                               // default "elegant"
export type ThemeContrast = "standard" | "medium" | "high"
export type ExtendedRole = "paid" | "proforma" | "overdue" | "draft"

export interface ResolvedScheme {
  readonly roles: Record<M3ColorRole, Hex>        // primary, onPrimary, ..., surfaceContainerHighest, inverseSurface, ...
  readonly extended: Record<ExtendedRole, {
    readonly color: Hex; readonly onColor: Hex; readonly colorContainer: Hex; readonly onColorContainer: Hex
  }>
}
export interface ResolvedTheme {
  readonly source: ThemeSource
  readonly schemes: {
    readonly light: ResolvedScheme; readonly dark: ResolvedScheme
    readonly lightMedium: ResolvedScheme; readonly lightHigh: ResolvedScheme
    readonly darkMedium: ResolvedScheme; readonly darkHigh: ResolvedScheme
  }
}
// Account: GET/PATCH /api/v1/me/preferences  -> AccountPreferences { locale, theme: { mode, style, contrast, dynamicColor, source }, resolvedTheme, revision }
// Workspace: GET/PATCH /api/v1/workspaces/{ws}/branding -> BrandingView { ..., theme, resolvedTheme, revision }
// Stateless: POST /api/v1/themes/resolve { source, contrast? } -> ResolvedTheme
```

Precedence for app chrome (AG-HTTP-THEME):

1. Android dynamic colour, when `dynamicColor` is on and the device supports it (Android 12 and later). The system supplies the M3 roles; ui-port still needs harmonized extended colours (section 4.4).
2. The account theme (`AccountPreferences.theme.source`, when not null).
3. The active Workspace theme (`BrandingView.theme`, when not null).
4. `KvitbitDefaultTheme`, a `ResolvedTheme` constant shipped inside `@kvitbit/ui-port/theme`.

PDFs and the Public Share Link page use the Workspace branding only; the share page presenter (screen 04) receives the Workspace's resolved scheme in its view and never reads the visitor's preferences.

### 4.2 ThemeState

```ts
export interface ThemeState {
  readonly preference: {
    readonly mode: ThemeMode
    readonly style: ThemeStyle                                   // default "elegant"; selects type and shape tokens, not colour
    readonly contrast: ThemeContrast
    readonly dynamicColor: boolean
    readonly source: Option.Option<ThemeSource>
  }
  readonly system: {
    readonly scheme: "light" | "dark"                            // SystemTheme port
    readonly highContrast: boolean                               // prefers-contrast: more / Android high-contrast text
    readonly dynamic: Option.Option<{ readonly light: Record<M3ColorRole, Hex>; readonly dark: Record<M3ColorRole, Hex> }>
  }
  readonly account: Option.Option<ResolvedTheme>
  readonly workspace: Option.Option<ResolvedTheme>
  readonly dynamicExtended: Remote<{ readonly light: ResolvedScheme["extended"]; readonly dark: ResolvedScheme["extended"] }>
  readonly draft: Option.Option<ThemeDraft>                        // Appearance or Branding editor in progress (preview)
}

/** Typography and shape tokens per style; values are DESIGN.md "Selectable Styles". */
export interface StyleTokens {
  readonly font: {
    readonly display: { readonly family: string; readonly weight: 600 }          // elegant "Erode", cozy "Chillax"
    readonly body: { readonly family: string; readonly weights: readonly [400, 500, 600] } // elegant "Recia", cozy "Synonym"
    readonly mono: { readonly family: "JetBrains Mono"; readonly weights: readonly [400, 500] }
    readonly tabularNumerals: boolean                                             // elegant true (lnum, tnum on amounts); cozy false (lining by default)
  }
  readonly shape: {
    readonly panel: number                                                        // px: elegant 4, cozy 12
    readonly control: number                                                      // buttons, inputs, sheets: elegant 4, cozy 8
    readonly badge: number                                                        // elegant 3, cozy 999 (pill)
  }
  readonly surface: "flat" | "tonal"                                              // elegant flat with 1px outlineVariant borders; cozy M3 tonal steps
}
export const StyleTokens: Record<ThemeStyle, StyleTokens>                         // constant in @kvitbit/ui-port/theme

export interface EffectiveTheme {
  readonly scheme: "light" | "dark"
  readonly contrast: ThemeContrast
  readonly origin: "dynamic" | "account" | "workspace" | "default" | "draft"
  readonly roles: Record<M3ColorRole, Hex>
  readonly extended: ResolvedScheme["extended"]
  readonly style: ThemeStyle                                                      // draft.style while Appearance previews, else preference.style
  readonly tokens: StyleTokens                                                    // StyleTokens[style]
}

/** Pure. Adapters apply the result: CSS variables on web, a theme object on mobile. */
export const effectiveTheme: (state: ThemeState) => EffectiveTheme
```

`effectiveTheme` picks the source by precedence (a `draft` wins while an editor previews it), then the scheme (`mode`, falling back to `system.scheme` for `"system"`), then the contrast variant (`preference.contrast`, raised to at least `medium` when `system.highContrast`). Style is independent of the colour source: `style` is `draft.style` while the Appearance editor previews a draft, otherwise `preference.style` (default `"elegant"`); a Branding draft carries no style and never changes it, and Workspace branding has no style, so the share page and PDFs never follow a viewer's style. It is a pure function, so first paint on both platforms is deterministic: web SSR computes it on the server from the account preferences and inlines the variables, and mobile computes it from the cached preferences before the first frame.

### 4.3 Material Theme Builder JSON parser

The parser is a Schema in ui-port, used for immediate feedback when a user imports a file, and for a local preview of the file's own schemes before the server resolves it. It needs no colour maths: Material Theme Builder exports already contain the full role schemes.

```ts
// @kvitbit/ui-port/theme/MaterialThemeJson.ts
const Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^#[0-9A-Fa-f]{6}$/)), Schema.brand("Hex"))
const RoleScheme = Schema.Record(Schema.String, Hex)               // keys checked against M3ColorRole below

export const MaterialThemeJson = Schema.Struct({
  description: Schema.optional(Schema.String),
  seed: Hex,
  coreColors: Schema.Struct({
    primary: Hex,
    secondary: Schema.optional(Hex), tertiary: Schema.optional(Hex), error: Schema.optional(Hex),
    neutral: Schema.optional(Hex), neutralVariant: Schema.optional(Hex),
  }),
  extendedColors: Schema.optional(Schema.Array(Schema.Struct({
    name: Schema.String, color: Hex, description: Schema.optional(Schema.String), harmonized: Schema.Boolean,
  })), { default: () => [] }),
  schemes: Schema.Struct({
    light: RoleScheme, dark: RoleScheme,
    "light-medium-contrast": Schema.optional(RoleScheme), "light-high-contrast": Schema.optional(RoleScheme),
    "dark-medium-contrast": Schema.optional(RoleScheme), "dark-high-contrast": Schema.optional(RoleScheme),
  }),
  palettes: Schema.optional(Schema.Unknown),                       // not used by Kvitbit
})

export interface ParsedThemeFile {
  readonly json: unknown                                           // sent unchanged as ThemeSource.MaterialThemeBuilder.json
  readonly seed: Hex
  readonly preview: { readonly light: Record<M3ColorRole, Hex>; readonly dark: Record<M3ColorRole, Hex> }
  readonly extendedFound: ReadonlyArray<ExtendedRole>              // which of paid/proforma/overdue/draft the file defines
  readonly warnings: ReadonlyArray<"missing_contrast_schemes" | "unknown_roles_ignored" | "no_extended_colours">
}

/** Pure. Size and shape checks mirror the server so the user sees the same Invalid codes. */
export const parseMaterialThemeFile: (text: string, maxBytes: number) =>
  Either.Either<ParsedThemeFile, Invalid>  // theme.too_large | theme.json_invalid | theme.roles_missing
```

Rules:

- M1. The byte limit comes from `GET /api/v1/config` (`uploads.themeJson.maxBytes`, 64 KB). Checked before `JSON.parse`.
- M2. Every M3 role in `M3ColorRole` must be present in `light` and `dark`; unknown keys are ignored with a warning (newer Theme Builder exports add roles).
- M3. Extended colours are matched by case-insensitive name: `paid`, `proforma`, `overdue`, `draft`. The `harmonized` flag is passed through; the server applies it (AG-HTTP-THEME).
- M4. The client never stores a resolved theme as the source of truth. On save it sends the raw `json` and stores the `ResolvedTheme` the server returns.

### 4.4 ThemeEngine port and Android dynamic colour

```ts
// @kvitbit/ui-port/ports/ThemeEngine.ts
export class ThemeEngine extends Context.Service<ThemeEngine, {
  /** Seeds, presets and MTB files to a full ResolvedTheme. Default implementation: POST /api/v1/themes/resolve. */
  readonly resolve: (source: ThemeSource, contrast: ThemeContrast) => Effect.Effect<ResolvedTheme, UiError>
  /**
   * Harmonized extended colours against an arbitrary primary (Android dynamic colour).
   * Remote default: resolve({ _tag: "Seed", seed: primary }) and take its extended roles.
   * apps/mobile overrides it with a local implementation so it works offline.
   */
  readonly harmonizeExtended: (primary: { readonly light: Hex; readonly dark: Hex }, contrast: ThemeContrast) =>
    Effect.Effect<{ readonly light: ResolvedScheme["extended"]; readonly dark: ResolvedScheme["extended"] }, UiError>
}>()("ui-port/ThemeEngine") {}

export const RemoteThemeEngine: Layer.Layer<ThemeEngine, never, KvitbitApi>
```

ui-port bundles no colour library (AG-HTTP-THEME item 6). `apps/mobile` provides `LocalThemeEngine` built on `@material/material-color-utilities`, pinned to the same version as the server, used only for `harmonizeExtended` with the dynamic system primary. A contract test in `apps/mobile` checks that `LocalThemeEngine.harmonizeExtended(p)` equals the server's `resolve(Seed p).extended` for a table of primaries. Seed editing on both platforms uses `resolve` with a 300 ms debounce (key `theme.resolve`); while the request runs, the preview keeps the last resolved scheme.

Dynamic colour is read by the `SystemTheme` port on Android (`@pchmn/expo-material3-theme`, or the maintained equivalent, section 12). Web and the PWA report `dynamic = None`, and the Appearance screen hides the dynamic colour switch there.

### 4.5 Built-in presets

`ThemePresetId` is a closed union in `@kvitbit/api-contract` (`graphite_atelier`, `forest`, `ocean`, `plum`, `sand`, `graphite`, matching core-ports). ui-port only references ids and shows swatches from `ThemePresets[id].seed`. The default theme constant is generated from the `graphite_atelier` preset at build time by calling the server resolver in a script, checked in as data, and guarded by a snapshot test that re-resolves it in CI, so client and server never disagree on the default.

### 4.6 Applying the theme

| | Foldkit Web (`apps/web`) | Expo Mobile (`apps/mobile`, APK and PWA) |
|---|---|---|
| Roles | CSS custom properties `--md-sys-color-<role-kebab>` on `:root` (for example `--md-sys-color-surface-container-high`) | a `MaterialTheme` object (`colors.<role>`) in a React context, read by the M3 component kit and Kvitbit primitives |
| Extended | `--kb-color-paid`, `--kb-color-on-paid`, `--kb-color-paid-container`, `--kb-color-on-paid-container`, same for `proforma`, `overdue`, `draft` | `extended.paid.color` etc. on the same object |
| Light, dark, system | SSR inlines both light and dark variable sets; `mode: "system"` uses `@media (prefers-color-scheme: dark)`, explicit modes set `data-theme` on `<html>`. No flash on load. | `Appearance` / `useColorScheme` feeds `SystemTheme`; the theme object switches without remount |
| Contrast | `data-contrast="standard\|medium\|high"` selects the variable set; `prefers-contrast: more` raises to at least medium | the matching scheme variant |
| Dynamic colour | not available | Android 12+ system roles plus `harmonizeExtended` |
| Status badges | `BadgeVM.role` maps to role or extended variables | same mapping to the theme object |
| Style | SSR sets `data-style="elegant\|cozy"` on `<html>` and inlines `--kb-font-display`, `--kb-font-body`, `--kb-font-mono`, `--kb-shape-panel`, `--kb-shape-control`, `--kb-shape-badge` from `EffectiveTheme.tokens`; only the active style's font files are preloaded, so a saved style paints on first load; a previewed style loads the other style's fonts and swaps the attribute and variables without reload | `fonts` and `roundness` on the theme object (and the M3 kit's `fonts` / `roundness`) from `EffectiveTheme.tokens`, fonts registered with `expo-font` before the first frame; a preview or save swaps the object without remount |

WCAG 2.1 AA (PRODUCT.md) is checked in CI for every preset and for the default: `onX` against `X` and `onXContainer` against `XContainer` at 4.5:1 for text. A user-imported theme that fails contrast is accepted (it is their choice) but the Appearance screen shows a warning listing the failing pairs, computed in ui-port with a pure relative-luminance function.

---

## 5. Platform ports

Ports are `Context.Service` tags in `@kvitbit/ui-port/ports`. Their interfaces use only `effect` types and ui-port data types. Each port lists its web (Foldkit), Android (Expo native) and PWA (Expo web export) implementation.

`UiServices` is the union of every tag below plus `KvitbitApi`. Commands require `UiServices`; tests provide `TestUiServices`.

### 5.1 AuthClient

```ts
export class AuthClient extends Context.Service<AuthClient, {
  readonly getSession: Effect.Effect<Option.Option<AuthSession>, UiError>
  readonly signUpEmail: (i: { email: string; password: string; name: string; locale: Locale; invitation?: string },
    proof: Option.Option<string>) => Effect.Effect<void, UiError>                       // 200 even if registered (flow 1.2)
  readonly signInEmail: (i: { email: string; password: string }, proof: Option.Option<string>) => Effect.Effect<AuthSession, UiError>
  readonly sendMagicLink: (email: string, proof: Option.Option<string>, returnTo: Option.Option<string>) => Effect.Effect<void, UiError>
  readonly verifyLink: (kind: "verify" | "magic", token: string) => Effect.Effect<AuthSession, UiError> // NotFound = expired or used
  readonly resendVerification: (email: string) => Effect.Effect<void, UiError>
  readonly requestPasswordReset: (email: string, proof: Option.Option<string>) => Effect.Effect<void, UiError>
  readonly resetPassword: (token: string, password: string) => Effect.Effect<void, UiError>
  readonly changePassword: (current: string, next: string, revokeOthers: boolean) => Effect.Effect<void, UiError>
  readonly changeEmail: (email: string) => Effect.Effect<void, UiError>
  readonly updateUser: (patch: { name?: string }) => Effect.Effect<void, UiError>
  readonly passkeySignIn: Effect.Effect<AuthSession, UiError | PasskeyCancelled>         // uses PasskeyBridge.get
  readonly passkeyAdd: (name: string) => Effect.Effect<PasskeyView, UiError | PasskeyCancelled> // uses PasskeyBridge.create
  readonly passkeys: Effect.Effect<ReadonlyArray<PasskeyView>, UiError>
  readonly renamePasskey: (id: string, name: string) => Effect.Effect<void, UiError>
  readonly removePasskey: (id: string) => Effect.Effect<void, UiError>                   // Conflict{last_sign_in_method} (flow 1.5)
  readonly sessions: Effect.Effect<ReadonlyArray<SessionView>, UiError>
  readonly revokeSession: (id: string | "others") => Effect.Effect<void, UiError>
  readonly signOut: Effect.Effect<void, UiError>
  readonly deleteAccount: (confirm: { password?: string }) => Effect.Effect<void, UiError> // soft delete (Q7)
}>()("ui-port/AuthClient") {}
```

| Implementation | Web | Android | PWA |
|---|---|---|---|
| Client | `better-auth/client` with magic link and passkey plugins, cookie session | `@better-auth/expo` client, session in `expo-secure-store`, bearer on API calls (AG-UI-1) | `better-auth/client`, cookie session scoped to `/` |
| Errors | adapter maps Better Auth error codes to `UiError` (`Invalid` with `auth.*` IssueCodes, `InvalidBotProof`, `RateLimited`) | same mapping module, shared as source | same |

The mapping from Better Auth error codes to `UiError` is a table in each adapter, tested against the pinned Better Auth version.

### 5.2 PasskeyBridge and BotProof

```ts
export class PasskeyBridge extends Context.Service<PasskeyBridge, {
  readonly availability: Effect.Effect<"available" | "unavailable" | "hybrid_only">
  readonly create: (options: PublicKeyCredentialCreationOptionsJSON) =>
    Effect.Effect<RegistrationResponseJSON, PasskeyCancelled | PasskeyFailed>
  readonly get: (options: PublicKeyCredentialRequestOptionsJSON) =>
    Effect.Effect<AuthenticationResponseJSON, PasskeyCancelled | PasskeyFailed>
}>()("ui-port/PasskeyBridge") {}
// The JSON option and response types are declared in ui-port as Schemas (WebAuthn Level 3 JSON forms), not DOM types.

export class BotProof extends Context.Service<BotProof, {
  readonly solve: (challenge: AltchaChallenge) => Stream.Stream<
    { readonly _tag: "Progress"; readonly value: number } | { readonly _tag: "Solved"; readonly payload: string },
    UiError>
}>()("ui-port/BotProof") {}
```

| Port | Web | Android | PWA |
|---|---|---|---|
| PasskeyBridge | `navigator.credentials` with JSON conversion | Android Credential Manager through `react-native-passkey` (confirm library, section 12); Digital Asset Links on the server domain | `navigator.credentials` |
| BotProof | `altcha-lib` solver in a Web Worker | `react-native-altcha` with `react-native-quick-crypto` (ADR 0002), solved off the JS thread where the library allows | Web Worker solver |

`PasskeyCancelled` returns to the form with no error banner (flow 1.5). `hybrid_only` (no local passkey) still calls `get`, and the platform offers the QR hand-off.

### 5.3 Capture, files and transfer

```ts
export interface LocalFile {
  readonly ref: LocalFileRef            // opaque: file:// URI on Android, IndexedDB key or object URL on web/PWA
  readonly name: string
  readonly contentType: string
  readonly size: number
  readonly sha256: string               // computed by the adapter; drives dedupe and attach idempotency (core C6)
}

export class Capture extends Context.Service<Capture, {
  readonly camera: (opts: { readonly multiple: boolean }) => Effect.Effect<ReadonlyArray<LocalFile>, CaptureCancelled | CaptureFailed>
  readonly gallery: Effect.Effect<ReadonlyArray<LocalFile>, CaptureCancelled | CaptureFailed>
  readonly files: (accept: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<LocalFile>, CaptureCancelled | CaptureFailed>
  readonly incoming: Stream.Stream<ReadonlyArray<LocalFile>>   // Android share sheet (flow 5.2), web drag-and-drop
  readonly persist: (file: LocalFile) => Effect.Effect<LocalFile, CaptureFailed> // copy into app-owned storage for the queue
  readonly release: (ref: LocalFileRef) => Effect.Effect<void>
}>()("ui-port/Capture") {}

export class Transfer extends Context.Service<Transfer, {
  /** Multipart, one part named "file" (AG-UI-1 P5). Progress 0..1. */
  readonly upload: (req: { readonly url: string; readonly file: LocalFile; readonly headers: Record<string, string> }) =>
    Stream.Stream<{ readonly _tag: "Progress"; readonly value: number } | { readonly _tag: "Done"; readonly body: unknown }, UiError>
  readonly download: (req: { readonly url: string; readonly filename: string; readonly inline: boolean }) =>
    Effect.Effect<LocalFile, UiError>
  readonly open: (file: LocalFile) => Effect.Effect<void, UiError>   // system viewer or in-app viewer
  readonly save: (file: LocalFile) => Effect.Effect<void, UiError>   // browser download, Android SAF / share-to-save
}>()("ui-port/Transfer") {}
```

| Port | Web | Android | PWA |
|---|---|---|---|
| Capture.camera | `<input type="file" accept="image/*" capture="environment">` | `expo-camera` screen with edge guides (screen 13), falling back to `expo-image-picker` camera | `<input capture>` |
| Capture.files, gallery | file input | `expo-document-picker`, `expo-image-picker` | file input |
| Capture.incoming | drag-and-drop on the Expenses list | Android `SEND`/`SEND_MULTIPLE` intent filter via a config plugin (for example `expo-share-intent`) | Web Share Target in the PWA manifest |
| Capture.persist | IndexedDB blob store | copy to `FileSystem.documentDirectory + "capture-queue/"` | IndexedDB |
| Transfer.upload | `fetch` with a streamed `FormData` body; progress through `XMLHttpRequest.upload` | `expo-file-system` `createUploadTask` with `uploadType: MULTIPART`, `fieldName: "file"`, auth header | XHR |
| Transfer.download | `fetch` to Blob, or a plain `<a href download>` when no progress is needed | `expo-file-system` `downloadAsync` with auth header into the cache directory | fetch to Blob |
| Transfer.open | new tab for PDFs with `?disposition=inline`; in-app image viewer | in-app PDF viewer (`react-native-pdf` or equivalent) or `expo-sharing` / intent to the system viewer | new tab |

HEIC photos are uploaded as captured; the server accepts HEIC (AG-UI-1). The Android camera path saves JPEG by default, so HEIC only arrives from files.

### 5.4 Device and environment ports

| Port | Interface (summary) | Web | Android | PWA |
|---|---|---|---|---|
| `Connectivity` | `current: Effect<boolean>`, `changes: Stream<boolean>` | `navigator.onLine` and online/offline events | `@react-native-community/netinfo` (`isInternetReachable`) | browser events |
| `AppLifecycle` | `changes: Stream<"active" \| "background">` | `visibilitychange` | `AppState` | `visibilitychange` |
| `SystemTheme` | `scheme`, `highContrast`, `dynamic`, `changes` | `matchMedia` | `Appearance`, `AccessibilityInfo`, dynamic colour module | `matchMedia` |
| `Clipboard` | `copy(text): Effect<void>` | `navigator.clipboard` | `expo-clipboard` | `navigator.clipboard` |
| `ShareSheet` | `share({ url, title, text }): Effect<"shared" \| "dismissed" \| "unsupported">` | `navigator.share`, else `unsupported` (presenter falls back to copy) | `Share.share` | `navigator.share` |
| `ExternalLink` | `open(url)` | `window.open` | `expo-web-browser` / `Linking` | `window.open` |
| `DeepLinks` | `incoming: Stream<string>`, `initial: Effect<Option<string>>` | Foldkit URL changes | `expo-linking` and Android App Links for `/auth/*`, `/invite/*`, `/s/*` | URL |
| `KeyValue` | `get`, `set`, `remove` on string keys; for caches only (last workspace, cached preferences, cached theme) | `localStorage` | `react-native-mmkv` or AsyncStorage | `localStorage` |
| `CaptureStore` | `load: Effect<ReadonlyArray<CaptureJob>>`, `put(job)`, `remove(id)`; durable, transactional per job | not provided (no queue on web) | SQLite (`expo-sqlite`) table, one row per job | IndexedDB |
| `Ids` | `requestKey: Effect<RequestKey>` (UUIDv7), `local: Effect<string>` | `crypto.getRandomValues` | `expo-crypto` | web crypto |
| `Haptics` (optional) | `tap`, `success`, `warning` | no-op | `expo-haptics` | no-op |

`Clock` uses Effect's own `Clock` service; adapters do not replace it. `today` in `ScreenContext` is derived from it in Europe/Prague by the Shell.

---

## 6. Offline Expense capture queue (Android and PWA)

Decision Q9: only Expense photo and PDF captures work offline. The queue is a portable program (`CaptureQueue`) inside the Shell, so its behaviour is the same on the APK and the PWA and is tested once.

### 6.1 Job model

```ts
export interface CaptureJob {
  readonly id: CaptureJobId                         // local UUID
  readonly workspace: { readonly id: WorkspaceId; readonly slug: WorkspaceSlug; readonly name: string } // pinned at capture
  readonly createdAt: string
  readonly requestKey: RequestKey                    // Idempotency-Key for POST expenses, minted once at capture
  readonly fields: ExpenseDraft                      // whatever the user filled offline; may be empty ("Incomplete")
  readonly expense: Option.Option<{ readonly id: ExpenseId; readonly revision: number }> // set after record succeeds
  readonly files: ReadonlyArray<{
    readonly file: LocalFile                        // persisted copy (Capture.persist)
    readonly state:
      | { readonly _tag: "Queued" }
      | { readonly _tag: "Uploading"; readonly progress: number }
      | { readonly _tag: "Uploaded"; readonly attachment: AttachmentId }
      | { readonly _tag: "Rejected"; readonly issue: FieldIssue }        // too large, type rejected: never retried
  }>
  readonly state:
    | { readonly _tag: "Waiting" }                                       // offline or not yet started
    | { readonly _tag: "Running" }
    | { readonly _tag: "Backoff"; readonly attempt: number; readonly nextAt: string; readonly error: UiError }
    | { readonly _tag: "NeedsSignIn" }                                   // 401: paused until a session exists
    | { readonly _tag: "Blocked"; readonly error: UiError }              // 403/404 on the workspace, 422 on fields: needs the user
    | { readonly _tag: "Done"; readonly expense: ExpenseId }
}
```

### 6.2 Replay protocol

For one job, strictly in order, and at most one job running per Workspace at a time:

1. **Record.** If `expense` is None: `POST /api/v1/workspaces/{ws.id}/expenses` with `Idempotency-Key: requestKey` and the fields. When fields are incomplete, the request asks core to save the Expense as Incomplete (flow 5.2 branch; gap G4 confirms the core field). A replay after a lost response returns the stored Expense (`Idempotent-Replayed: true`). Store `expense` in the job and persist the job before the next step.
2. **Attach.** For each file not `Uploaded` or `Rejected`: `Transfer.upload` to `.../expenses/{id}/attachments`. Core attaches idempotently by content hash (core rule C6), so a repeat after an ambiguous failure yields the same `AttachmentId`. Persist after each file.
3. **Finish.** When every file is `Uploaded` or `Rejected`: state `Done`, release local copies (`Capture.release`), toast "Receipt saved to <workspace>" with "Open", and remove the job after the toast is shown. Rejected files stay listed on the Expense editor with their issue.

Triggers: `Connectivity.changes` to online, `AppLifecycle` to active, a new capture, the user tapping Retry, and the backoff timer. Backoff is 5 s, 30 s, 2 min, 10 min, then every 30 min, reset by a connectivity change.

Failure mapping:

| Error | Job state |
|---|---|
| `Offline`, `Timeout`, `Unavailable`, `RateLimited`, 5xx | `Backoff` |
| `Unauthorized` | `NeedsSignIn`; resumes after sign-in to the same account. A different account sees the job as `Blocked` with "Captured by another account" and can only discard it. |
| `Forbidden`, `NotFound` on the Workspace | `Blocked`: "You no longer have access to <workspace>". The user can export the files (share sheet) or discard. |
| `Invalid` on fields | `Blocked` with field errors; opening the job shows the Expense editor (screen 14) with the job's fields. |
| `Invalid{attachment.*}`, `PayloadTooLarge` on one file | that file `Rejected`; the job continues. |
| `Conflict{idempotency_mismatch}` | Defect. The job keeps its key and is `Blocked` with a support id; this can only happen if the fields changed after a record that the client believed failed. Rule Q1 below prevents it. |

Rules:

- Q1. Fields are frozen once step 1 has been attempted. Later edits go through the normal Expense editor against the created Expense (with If-Match), not through the job.
- Q2. File size and type are checked against `config.uploads.attachment` at capture time, so an oversized file never enters the queue.
- Q3. The job is pinned to the Workspace that was active at capture. Switching Workspace does not move it. The queue badge in the Shell counts jobs across all Workspaces.
- Q4. On Android, a best-effort background drain registers with `expo-background-task` (WorkManager). The foreground drain is the guarantee; background drain only shortens the wait.
- Q5. Exactly-once is a test: a property test kills the replay at every step boundary (before and after each request, before and after each persist) and asserts one Expense and one attachment per distinct file hash.

Online capture uses the same protocol with no wait, so there is one code path. Web (`apps/web`) has no queue: drag-and-drop uploads run directly with `Transfer.upload` and show an error row on failure.

---

## 7. Adapters

### 7.1 Foldkit Web (`apps/web`)

```ts
// apps/web/src/main.ts (sketch; Foldkit names to confirm, section 12)
import { Runtime } from "foldkit"
import { AppShell, Routes, toFoldkit } from "@kvitbit/ui-port"

const app = toFoldkit(AppShell, {
  view: ShellView,                                  // renders AppShell.present(model) with @foldkit/ui
  routing: {
    onUrlChange: (url) => ShellMsg.RouteChanged({ route: Routes.fromPath(url.pathname + url.search, "/") }),
    onUrlRequest: (req) => ShellMsg.LinkClicked({ req }),
  },
})

Runtime.makeApplication({ ...app, container: document.getElementById("root")!, layer: WebUiServices })
```

`toFoldkit(program, options)` is a thin adapter in `apps/web` (not in ui-port):

| ui-port concept | Foldkit mapping |
|---|---|
| `Program.Model`, `Message` Schemas | Foldkit Model and Message Schemas directly (Foldkit is Schema-based) |
| `update` returning `Next` | Foldkit update returning `[model, commands]`; `Navigate` intents become Foldkit navigation commands (`pushUrl`/`replaceUrl` of `Routes.toPath`); other intents are already handled inside the Shell's update |
| `Command<Msg>` | Foldkit Command (an Effect producing a Message), run with the `WebUiServices` layer; `key` supersession implemented by a small keyed-fiber map in the adapter |
| `Subscription<Msg>` | Foldkit subscriptions keyed by `key` |
| `present(model)` | pure input to view functions; views never read the Model |
| SSR | Foldkit SSR (experimental, ADR 0001) renders public routes and the signed-in shell. The server runs `init` with flags loaded through `KvitbitApi` using the forwarded cookie, encodes the Model with its Schema into the page, and the client hydrates by decoding it. Public Share Link (screen 04), landing, legal, `/android` and auth pages are always SSR. |

`WebUiServices` = `KvitbitApi` (`HttpApiClient.make(Api, { baseUrl: "/api/v1" })` over `FetchHttpClient` with `credentials: "same-origin"`), `AuthClient` (Better Auth web client), `RemoteThemeEngine`, and the web column of every port in section 5.

Components: views compose `@foldkit/ui` elements with `@ui-sdk/core` behaviours for the stateful widgets (combobox for Contact and Price List search, listbox, menu, dialog focus trap, date picker grid). Where a `@ui-sdk/core` behaviour holds its own state machine, its state lives in the screen Model as an opaque Schema field and its events are Messages, so TEA remains the single source of truth. `@ui-sdk/web` custom elements are allowed for leaf widgets with no domain state (for example a QR SVG frame).

Web-only ergonomics live in the adapter or in `present` branches keyed by `formFactor`, never in `update`: keyboard shortcuts (Ctrl/Cmd+K Workspace switcher, `n` new document, `/` focus search) are a Foldkit subscription that emits the same Messages a click would.

Layout by `formFactor`: `expanded` (1280x800 target) uses a navigation rail or drawer plus list-detail panes for Documents, Expenses and Contacts; `compact` web uses the same layout as mobile.

### 7.2 Expo Mobile (`apps/mobile`, Android APK and `/app/` PWA)

React Native has no TEA runtime, so `apps/mobile` provides a small one. It is the only place that knows both React and ui-port.

```ts
// apps/mobile/src/tea/useProgram.ts (sketch)
export function useProgram<M, Msg, F, VM>(program: Program<M, Msg, F, VM>, flags: F): readonly [VM, (msg: Msg) => void] {
  const runtime = useUiRuntime()                     // ManagedRuntime.make(MobileUiServices), one per app
  const ctx = useScreenContext()                     // from the Shell store
  const store = useRef(createStore(program, flags, ctx, runtime)).current // model, dispatch, keyed command fibers, subscription diff
  const model = useSyncExternalStore(store.subscribe, store.getModel)
  useEffect(() => store.dispose, [])                 // interrupts commands and subscriptions on unmount
  return [useMemo(() => program.present(model, ctx), [model, ctx]), store.dispatch] as const
}
```

| ui-port concept | Expo mapping |
|---|---|
| Shell | one store created in `app/_layout.tsx`, exposed by context; owns session, theme, overlay, capture queue |
| Screen program | one store per mounted route component; expo-router keeps stacked screens mounted, so going back restores state without refetching. On Android process death, the Model is restored from its Schema encoding saved in `KeyValue` on `background` |
| `Navigate` intent | `router.push`/`router.replace` with `Routes.toPath(route, base)`; `NavigateBack` uses `router.back()` or the fallback |
| Route params | expo-router segments and search params decoded with `Routes.fromPath` into the program's `Flags` |
| Toast, Confirm | Shell overlay rendered as M3 snackbar and dialogs in the root layout |
| `present(model)` | the only input to components |

expo-router tree (mirrors section 2.10):

```
app/
  _layout.tsx                         Shell store, theme provider, overlay host
  (public)/sign-in.tsx  sign-up.tsx  check-email.tsx  auth/[kind]/[token].tsx  reset-password.tsx
  (public)/invite/[token].tsx         consent/[consentId].tsx
  onboarding.tsx  account/[tab].tsx
  w/[ws]/(tabs)/_layout.tsx           M3 navigation bar: Home, Documents, Expenses, Contacts, More; "+" FAB menu
  w/[ws]/(tabs)/index.tsx             Dashboard
  w/[ws]/(tabs)/documents/index.tsx   documents/[id].tsx  documents/[id]/edit.tsx  documents/new.tsx
  w/[ws]/(tabs)/expenses/index.tsx    expenses/capture.tsx  expenses/[id].tsx
  w/[ws]/(tabs)/contacts/index.tsx    contacts/[id].tsx
  w/[ws]/(tabs)/more/index.tsx        more/templates/... more/price-list.tsx more/reports/... more/settings/[section].tsx
```

The Public Share Link (screen 04), landing, legal and `/android` pages are web-only (Public surface, `user-flows.md` 2.2); the Expo app opens share links in the browser.

Components: Kvitbit primitives on React Native core components, styled only from the theme object (section 4.6), with `@ui-sdk/core` behaviours for the same stateful widgets as web. A Material 3 component kit (react-native-paper v5 MD3 is the default candidate, section 12) supplies buttons, text fields, dialogs, snackbars, chips, navigation bar and FAB, with its colour slots filled from `EffectiveTheme.roles`. Bottom sheets carry the M08 to M11 action sheets. Every touch target is at least 48 dp; layouts reflow at 360 dp width and 200 % font scale (PRODUCT.md).

`MobileUiServices` = `KvitbitApi` over a fetch `HttpClient` with base URL from Expo config and the bearer from `expo-secure-store`, `AuthClient` (Better Auth Expo client), `ThemeEngine` (`RemoteThemeEngine` with `LocalThemeEngine.harmonizeExtended`), and the Android or PWA column of every port in section 5. The PWA build swaps native modules for their web implementations with platform-specific files (`*.web.ts`), so ui-port sees the same ports.

Native bridges summary: passkeys through Credential Manager; ALTCHA through `react-native-altcha` and `react-native-quick-crypto` (Expo prebuild, ADR 0002); camera through `expo-camera`; share intent through a config plugin; App Links for magic link, invitation and share URLs; dynamic colour through the M3 theme module; offline queue in `expo-sqlite` plus app-owned files.

### 7.3 What each adapter must not do

- Call `KvitbitApi` or `AuthClient` outside a ui-port Command.
- Decide permissions (`can` is evaluated in `present`; adapters render `ActionVM.state`).
- Format money, dates or VAT outside `@kvitbit/ui-port/format`.
- Hold domain state in component state. Purely visual state (scroll position, an open accordion with no business meaning) may stay in the adapter.

---

## 8. Screen presenter contracts (screens 01 to 25)

### 8.0 How to read this section

Each screen from `screens.md` lists its presenters (program ids), routes, the key Model fields, Messages, Commands (with the route they call), the states it must render, engine and form use, the `Action`s that gate its controls, and the mobile screen ids it covers. Shorthand: `ws/` = `/api/v1/workspaces/{ws}`, `auth/` = Better Auth through `AuthClient`.

Every presenter follows these shared contracts, so the per-screen entries list only what differs:

- **Loading**: `Remote.Loading` renders skeletons that keep the final layout; no spinner before 300 ms.
- **Empty**: `ListState.Empty` with `no_records` (first-use CTA) or `no_matches` (clear filters).
- **Error**: `ErrorVM` from the section 2.6 mapping, inline with Retry; whole-screen errors only for `NotFound`, `Forbidden` on read, or `Unexpected` on the primary load.
- **Selected**: `Selection` for list-detail panes (expanded web) and multi-select (bulk export, archive).
- **Optimistic**: per section 2.11; presenters list their optimistic operations.
- **Stale**: `StaleRevision` per section 2.6 for every form with `baseRevision`.
- **Offline**: `ctx.online = false` disables submit buttons with "You're offline" (except the capture queue).

Total: 60 presenters across the 25 screens. Screens 23 and 24 are server-rendered PDFs and 25 is server-rendered email, so ui-port contributes their in-app preview presenters, not their layouts (section 8.23 to 8.25).

### 8.1 Screen 01: Public Landing and Legal pages

| | |
|---|---|
| Presenters | `public.landing`, `public.legal` |
| Routes | `Landing`, `Legal { page }` |
| Model | `locale`, `config: ServerConfig` (self-hosted installs may hide sign-up), `legal: Remote<LegalDocument>` |
| Messages | `ChangedLocale`, `ClickedSignUp`, `ClickedSignIn`, `GotLegal` |
| Commands | `GET /api/v1/legal/{page}?locale=` (configurable EN/CZ templates, PRODUCT.md "no final operator legal entity name") |
| States | SSR-ready (no loading state on first paint), legal `Failed` shows a static fallback link |
| Platforms | web only (Public). The Expo app links out to these pages. |
| Flows | 1.1 |

Gap: the legal templates route is not in AG-UI-2; it is a static SSR page on the web adapter if #19 prefers (G11).

### 8.2 Screen 02: Public Auth

| | |
|---|---|
| Presenters | `auth.signUp`, `auth.signIn`, `auth.checkEmail`, `auth.link`, `auth.resetPassword` |
| Routes | `SignUp`, `SignIn`, `CheckEmail`, `AuthLink { kind, token }`, `ResetPassword` |
| Model (signUp) | `form: Form<SignUpDraft, SignUpInput>`, `method: "password" \| "passkey"`, `acceptedTerms`, `bot: BotProofState`, `invitation: Option<string>` |
| Model (signIn) | `mode: "password" \| "magic_link" \| "passkey"`, `form`, `bot` (starts `NotRequired`), `failures`, `returnTo` |
| Model (checkEmail) | `email`, `resend: { cooldownUntil: Option<string> }` (60 s, flow 1.2) |
| Model (link) | `kind`, `result: Remote<AuthSession>`; `NotFound` means expired or used |
| Messages | `ChangedField`, `ToggledTerms`, `BotProofProgressed`, `BotProofSolved`, `SubmittedForm`, `GotSignUp`, `ClickedPasskey`, `GotPasskey`, `ClickedResend`, `CooldownTicked`, `ClickedSendNewLink` |
| Commands | `GET /api/v1/bot-protection/challenges/{scope}`, `BotProof.solve`, `auth/sign-up/email`, `auth/sign-in/email`, `auth/sign-in/magic-link`, `auth/verify-email`, `auth/magic-link/verify`, `auth/send-verification-email`, `auth/request-password-reset`, `auth/reset-password`, `AuthClient.passkeySignIn` |
| States | submit disabled while `Solving` ("Verifying you're human" with progress on mobile); generic credentials error (no account probing); unverified email routes to `CheckEmail`; `PasskeyCancelled` returns silently; link expired state with "Send a new link" |
| Forms | email (`form.email_invalid`), password (server `auth.password_weak`, `auth.password_breached` as field errors), terms required |
| After success | Shell loads session and `listMine`: no Workspace goes to `Onboarding`; else `returnTo` or the last active Workspace's Dashboard (flow 1.3) |
| Mobile | M01, M02 |
| Flows | 1.2, 1.3, 1.4, 1.5 (sign in), 1.6 |

### 8.3 Screen 03: `/android` download and error pages

| | |
|---|---|
| Presenters | `public.androidDownload`, `public.error` |
| Routes | `AndroidDownload`, `Error { kind }` |
| Model | `release: Remote<AndroidRelease>` from `GET /api/mobile/releases/latest` (version, size, SHA-256, signing cert, Obtainium URL); `error.kind` |
| Messages | `GotRelease`, `ClickedCopyChecksum`, `ClickedObtainium`, `ClickedRetry`, `ClickedSwitchWorkspace` |
| States | release `Failed` keeps the Obtainium instructions visible; error kinds `not_found`, `no_access` (offers the Workspace switcher and sign out), `server` (request id), `offline` (mobile and PWA) |
| Flows | 1.7, shared error branches of all flows |

### 8.4 Screen 04: Public Share Link

```ts
export interface ShareModel {
  readonly token: ShareToken
  readonly view: Remote<SharedDocumentView>          // GET /api/v1/share/{token} (PublicShareLinks.open)
  readonly language: Locale                          // document language by default, visitor may switch
  readonly qr: Option.Option<{ readonly format: "spayd" | "epc"; readonly svg: string }> // PaymentQr.toSvg(view.paymentQr.payload)
  readonly download: { readonly _tag: "Idle" } | { readonly _tag: "Downloading" } | { readonly _tag: "Failed"; readonly error: UiError }
  readonly copied: Option.Option<"iban" | "vs" | "amount">
}
export type ShareMsg =
  | { _tag: "GotView"; result: ApiResult<SharedDocumentView> }
  | { _tag: "ChangedLanguage"; language: Locale }
  | { _tag: "ClickedDownloadPdf" } | { _tag: "GotPdf"; result: ApiResult<LocalFile> }
  | { _tag: "ClickedCopy"; field: "iban" | "vs" | "amount" } | { _tag: "CopiedCleared" }
```

| | |
|---|---|
| Caller | `ShareLinkVisitor`; no session, no Shell Workspace |
| Commands | `GET /api/v1/share/{token}`, `GET /api/v1/share/{token}/pdf?language=` via `Transfer.download` or plain link |
| States | status badge Unpaid, Partially paid, Paid, Overdue; Proforma shows "not a tax document"; Credit Note shows the corrected document number and no QR; CZK shows QR Platba, EUR shows EPC QR, other currencies show bank details only; Revoked, unknown and expired all render one "This link is no longer available" (core returns `NotFound` for all) |
| Theme | Workspace branding scheme from the view (section 4.1), never the visitor's |
| SSR | always; Model hydrates with the view so the QR shows without a client fetch |
| Flows | 8.2, 8.3, 8.4, and the revoked branch of 8.5 |

### 8.5 Screen 05: MCP OAuth consent and Invitation landing

| | |
|---|---|
| Presenters | `mcp.consent`, `invitation.landing` |
| Routes | `McpConsent { consentId }`, `Invitation { token }` |
| Model (consent) | `consent: Remote<ConsentView>` (client name, redirect host, `requestedAccess`, `requestedScopes`, Workspaces with `maxAccess`, `grantableScopes` and `offerableScopes`), `workspace: Option<WorkspaceId>`, `scopes: ScopePickerState` (section 8.21, `grantable` set to the chosen Workspace's `offerableScopes` = expanded `requestedScopes` ∩ `grantableScopes`; preselected with all of `offerableScopes`, in the requested preset mode when that preset's expansion fits, otherwise `custom`), `decision: Submit` posting `Approve { workspace, grant: AccessRequest }` or `Deny` |
| Model (invitation) | `invitation: Remote<InvitationInfo>`, `sessionMatches: boolean` (signed-in email equals invited email) |
| Commands | `GET/POST /api/v1/oauth/consents/{consentId}` then `ExternalLink.open(redirectTo)`; `GET /api/v1/invitations/{token}`, `POST /api/v1/invitations/{token}/accept` |
| States | consent: not signed in routes to `SignIn { returnTo }`; no Workspace shows "Create a Workspace first"; the picker never offers a scope the client did not request or the role cannot grant (presets whose expansion exceeds `offerableScopes` are disabled); an accountant keeps the requested subset of `<area>:read` scopes, with every `:write` checkbox disabled; a Workspace with empty `offerableScopes` shows "Your role here cannot grant what this app asks for" and disables approve; unknown redirect shows an error with no approve button (server refuses). Invitation: expired or revoked, already a member, different signed-in account ("Sign out and continue as x@y"), not signed in (sign up with the invitation prefilled, ALTCHA scope `invitation_accept`) |
| Flows | 10.8, 2.5 |

### 8.6 Screen 06: App Shell, navigation and Workspace switcher

| | |
|---|---|
| Presenters | `shell.app` (section 2.9), `shell.workspaceSwitcher` |
| Model (switcher) | `query`, `items: ReadonlyArray<WorkspaceSummary>` filtered locally, `highlighted`, `switching: Option<WorkspaceId>` |
| Messages | `OpenedSwitcher`, `ChangedQuery`, `MovedHighlight`, `PickedWorkspace`, `ClickedCreateWorkspace`, `ClickedSignOut`, `ConnectivityChanged`, `AppResumed`, `SystemThemeChanged`, `DeepLinkReceived`, `CaptureQueue*` |
| Commands | `GET /api/v1/workspaces` (`listMine`), `GET /api/v1/me/preferences`, `GET ws/branding` for the workspace theme, `auth/sign-out`, `KeyValue.set("lastWorkspace")` |
| Behaviour | switching replaces the route with the same section in the new Workspace when it exists (Documents stays Documents), else its Dashboard; open forms with unsaved edits ask to discard first (`Confirm "shell.discardChanges"`) |
| States | session loading (splash with cached theme), offline chip, capture queue badge (count of non-`Done` jobs, error tone when any is `Blocked`), "No access" for a foreign slug |
| Web | navigation rail or drawer (expanded), top app bar with switcher, Ctrl/Cmd+K |
| Mobile | M3 navigation bar (Home, Documents, Expenses, Contacts, More), "+" FAB menu: New Invoice, From template, Snap receipt, Record payment; switcher at the top of More |
| Mobile ids | M18 (More tab) |
| Flows | 2.3, 1.10 |

### 8.7 Screen 07: Workspace onboarding wizard

| | |
|---|---|
| Presenter | `onboarding.wizard` |
| Model | `step: "entity" \| "tax" \| "bank" \| "numbering"`, `ico: string`, `ares: Remote<CompanyPrefill>`, `form: Form<NewWorkspaceDraft, NewWorkspace>`, `requestKey`, `resumeFrom` |
| Messages | `ChangedIco`, `ClickedLookup`, `GotAres`, `ChangedField`, `ClickedNext`, `ClickedBack`, `SubmittedWizard`, `GotCreated` |
| Commands | `GET /api/v1/registry/companies/{ico}` (prefill, AG-UI-2), `POST /api/v1/workspaces` (`Workspaces.create`, Idempotency-Key) |
| Engines | `Numbering.parsePattern` and `format` to preview default series per kind |
| States | ARES `Unavailable` keeps manual entry open; `ico.checksum` before lookup; regime step explains each Tax Regime; bank step optional for `non_vat_payer` but warns that no QR prints without one; nothing is saved until the final step (flow 2.1 branch), so the draft lives in the Model and in `KeyValue` for resume |
| After | Shell refreshes `listMine`, navigates to the new Workspace's Dashboard |
| Mobile | M03 (compact: one step per screen) |
| Flows | 2.1, 2.2 |

### 8.8 Screen 08: Dashboard

| | |
|---|---|
| Presenter | `dashboard` |
| Model | `period: Period` (this month), `tiles: Remote<DashboardView>`, `overdue: Remote<ReadonlyArray<DocumentSummary>>` (5 most overdue), `recent: Remote<ReadonlyArray<DocumentSummary>>` (latest sent, viewed, paid), `cashflow: Remote<CashflowSeries>` (12 months) |
| Commands | `GET ws/reports/dashboard?from&to` (AG-HTTP-ASKS; core `Reports.dashboard`, gap G2 resolved), `GET ws/documents?overdue=true&limit=5`, `GET ws/documents?limit=10` for recent activity |
| States | each card loads and fails independently; empty Workspace shows quick actions only ("Create your first Invoice", "Snap a receipt") |
| Actions | quick actions gated by `can(document.draft)`, `can(expense.write)`, `can(payment.write)` |
| Mobile | M04 |
| Flows | 9.1, 8.6 (viewed activity) |

Recent activity is derived from document summaries (sent, viewed, paid badges and timestamps) because v1 has no activity feed (AG-UI-2, decision Q13).

### 8.9 Screen 09: Documents list

| | |
|---|---|
| Presenter | `documents.list` |
| Model | `list: Paged<DocumentSummary, DocumentListQuery>`, `selection: Selection<DocumentId>`, `tab: "all" \| "drafts" \| "invoices" \| "proformas" \| "tax_documents" \| "credit_notes"` |
| Query | `DocumentListQuery` = core `DocumentQuery` (kind, status, settlement, overdue, contact, period, text), mirrored in the route |
| Messages | `ChangedFilter`, `ChangedText` (debounced 250 ms, key `documents.search`), `ClickedLoadMore`, `PulledToRefresh`, `SelectedRow`, `CheckedRow`, `ClickedNew`, `ClickedDuplicate`, `ClickedDeleteDraft`, `Confirmed` |
| Commands | `GET ws/documents?cursor&limit&...`, `DELETE ws/documents/{id}` with If-Match (draft discard), `Navigate DocumentNew { from: Duplicate }` |
| Row VM | number or "Draft", contact, issued date, due date, total `MoneyVM`, badges (Sent, Viewed n, Partially paid, Paid, Overdue, Credited, Locked, Cancelled) |
| States | Loading, Empty (`no_records` CTA "Create your first Invoice"), `no_matches`, Error, Selected (detail pane on expanded web), draft delete is pessimistic with Confirm |
| Mobile | M05 |
| Flows | 3.5 (lock badge), 3.7, 8.6 |

### 8.10 Screen 10: Document Editor

```ts
export interface EditorModel {
  readonly mode:
    | { readonly _tag: "New"; readonly kind: "invoice" | "proforma"; readonly from: Option.Option<EditorSource> }
    | { readonly _tag: "Draft"; readonly id: DocumentId }
    | { readonly _tag: "Issued"; readonly id: DocumentId; readonly number: string; readonly paid: BigDecimal.BigDecimal }
  readonly form: Form<DocumentDraft, DocumentInput | DocumentPatch>
  readonly workspace: Remote<WorkspaceView>             // Tax Regime on the issue date, bank accounts, defaults
  readonly series: Remote<ReadonlyArray<NumberingSeriesView>>
  readonly contact: Remote<Option.Option<ContactView>>
  readonly contactPicker: ComboboxState<ContactSummary>   // GET ws/contacts?text=, inline "Add from ARES"
  readonly linePicker: ComboboxState<PriceListItemView>   // Price List search per line
  readonly local: VatBreakdown                            // VatMath.calculate on every change
  readonly server: Remote<DocumentView>                   // POST ws/documents/preview, debounced 400 ms
  readonly previewSeq: number
  readonly fx: FxPanelState                               // section 2.8: from preview | manual | unavailable
  readonly autosave: { readonly _tag: "Clean" } | { readonly _tag: "Dirty"; readonly since: string }
    | { readonly _tag: "Saving" } | { readonly _tag: "Saved"; readonly at: string } | { readonly _tag: "Failed"; readonly error: UiError }
  readonly warnings: ReadonlyArray<EditorWarning>         // no_bank_account_for_currency, price_list_currency_differs,
                                                          // total_below_payments (Q3), reverse_charge_needs_vat_id, qr_invalid
  readonly issue: Option.Option<IssueDialogModel>         // section 8.11, opened from the editor
}

export type EditorMsg =
  | { _tag: "ChangedField"; path: FieldPath; value: unknown }
  | { _tag: "AddedLine" } | { _tag: "RemovedLine"; index: number } | { _tag: "MovedLine"; from: number; to: number }
  | { _tag: "PickedPriceListItem"; index: number; item: PriceListItemView }
  | { _tag: "PickedContact"; contact: ContactSummary } | { _tag: "ContactCreatedInline"; contact: ContactView }
  | { _tag: "DebouncedPreview"; seq: number } | { _tag: "GotPreview"; seq: number; result: ApiResult<DocumentView> }
  | { _tag: "EnteredManualRate"; rate: string; quantity: string }
  | { _tag: "AutosaveDue" } | { _tag: "GotSaved"; result: ApiResult<DocumentView> }
  | { _tag: "ClickedSaveDraft" } | { _tag: "ClickedIssue" } | { _tag: "ClickedDiscard" }
  | { _tag: "ClickedRefreshParties" } | { _tag: "ClickedSaveToPriceList"; index: number }
  | { _tag: "GotRequestKey"; key: RequestKey } | { _tag: "Confirmed"; id: ConfirmId; input: string | null }
  | { _tag: "ClickedReload" }                              // StaleRevision
```

| | |
|---|---|
| Routes | `DocumentNew { kind, from }`, `DocumentEdit { id }` |
| Commands | `GET ws/documents/{id}`, `GET ws` (WorkspaceView), `GET ws/numbering-series`, `GET ws/contacts?text=`, `GET ws/price-list?text=`, `POST ws/documents/preview`, `POST ws/documents` (createDraft, Idempotency-Key), `PATCH ws/documents/{id}` (edit, If-Match), `POST ws/templates/{id}/use` for quick start (flow 4.2), `POST ws/price-list` (save a free-text line), `GET ws/fx-rates/{currency}?on=` only when preview is unavailable |
| Autosave | drafts only: 3 s after the last change (key `documents.autosave`), first save is `createDraft` with a request key, later saves `edit` with If-Match from the last saved revision. Issued documents never autosave: they save on an explicit "Save changes" with the issued-edit confirmation (flow 3.4) |
| Tax Regime variants | `present` hides VAT columns for `non_vat_payer` and shows the footer note; `vat_payer` shows taxable supply date, per-line treatment with `VatMath.rateFor`, and the per-bucket recap with CZK; `identified_person` offers `outside_scope` domestically and `reverse_charge` for EU B2B services. The regime comes from the Workspace on the issue date (core rule W2) |
| Engines | `VatMath.calculate` (local), `StatutoryText.title/notes` (preview panel), `PaymentQr.forDocument/toSvg` (preview panel), `Numbering.format` (number hint) |
| Forms | `DocumentDraft` with `DecimalText` quantities and prices; client rules mirror `document.lines_required`, `document.due_before_issue`, `document.buyer_vat_id_required` |
| States | Loading the document; New with source; Dirty, Saving, Saved ("Saved" in the header); Stale; Locked (`Conflict{document_locked}`: read-only with Unlock for owner/admin); Issued edit with warning banner "Edits are recorded in history" and number override for `can(document.overrideNumber)`; total below payments warning (Q3); FX panel states; preview drift |
| Optimistic | none for saves; line edits are local by nature |
| Mobile | M07 (one line per card, sticky totals bar, quick start from Contact or Template) |
| Flows | 3.1, 3.4, 3.7 (duplicate as source), 3.11, 4.2 |

### 8.11 Screen 11: Document Detail and action dialogs

`documents.detail` owns the page and embeds the dialog programs below as child Models (`dialog: Option<DialogModel>`), each opened by a route `dialog` param so deep links and back navigation work.

| Presenter | Model and behaviour | Commands | Gate (`can`) | Flows |
|---|---|---|---|---|
| `documents.detail` | `doc: Remote<DocumentView>`, `tab`, `pdf: PdfPreviewModel`, `payments: Remote<ReadonlyArray<PaymentView>>`; header badges, related documents, deliveries with bounce badge "Email bounced" and "Fix address and resend"; Lock toggle (optimistic), Unlock via `Confirm "document.unlock"` with `Reason` input; Duplicate | `GET ws/documents/{id}`, `PUT/DELETE ws/documents/{id}/lock`, `GET ws/payments?document=` | `document.read`, `document.lock`, `document.unlock` | 3.2 outcome, 3.5, 3.10, 8.6 |
| `documents.issue` | validation summary for kind and regime, number preview (`Numbering.format` of the series' next counter), missing bank account warning, Confirm then issue; on success optional "Send now" | `POST ws/documents/{id}/issue` (Idempotency-Key) | `document.issue` | 3.2 |
| `documents.send` | recipients (default Contact invoicing email), language, reminders toggle (default from `previewSend` `armsReminders`, i.e. the effective policy Document → Contact → Workspace; sending the untouched default omits `reminders`), purpose `document` or `reminder`, email copy preview (8.25) | `POST ws/documents/{id}/deliveries` (Idempotency-Key, AG-HTTP-ASKS) | `document.send` | 3.3, 7.4 |
| `documents.payment` | amount (defaults to amount due), currency fixed to the document's (P1), date, method; shows the resulting settlement; for a `vat_payer` Proforma shows the PTD split from `VatMath.splitAdvance` and "A Payment Tax Document will be issued"; payment list with Remove (`Confirm` with `Reason`) | `POST ws/payments` (Idempotency-Key), `DELETE ws/payments/{id}` | `payment.write` | 7.1, 7.2 |
| `documents.settlement` | Proforma settlement: payment state, issued PTDs, "Issue Final Invoice" with the deduction preview, optional patch | `POST ws/documents/{id}/final-invoice` (Idempotency-Key) | `document.finalInvoice` | 3.8 |
| `documents.creditNote` | full or partial, required reason, line picker with quantities or unit prices, inherits original FX and VAT rate (Q5), totals via `VatMath` with negated lines, `credit_note.exceeds_original` | `POST ws/documents/{id}/credit-notes` (Idempotency-Key) | `document.correct` | 3.9 |
| `documents.cancel` | storno: tax documents get a full Credit Note, non-tax documents are marked cancelled (core D6); reason and date | `POST ws/documents/{id}/cancel` (Idempotency-Key) | `document.cancel` | 3.7 (cancel instead of delete), 3.9 |
| `documents.share` | link state, Copy (Clipboard), Share (ShareSheet, falls back to copy), Revoke and Regenerate (Confirm), views count and last viewed | `PUT/DELETE ws/documents/{id}/share-link` | `share.write` | 8.1, 8.5, 8.6 |
| `documents.history` | audit entries newest first, actor (Member, System job, "via <client>" for MCP), changes with before and after, unlock reasons, view and download events | `GET ws/documents/{id}/history` | `document.history` | 3.6, 8.6 |

States: draft detail redirects to the editor; cancelled documents show the storno link; locked documents hide edit; accountants see read and download only (every write action hidden by `can`); a send to a document without a recipient email opens `documents.send` with the field focused.

Mobile: M06 (detail with PDF view), M08 (send and share sheet), M09 (record payment sheet), M10 (Proforma settlement sheet), M11 (Credit Note start sheet).

### 8.12 Screen 12: Invoice Templates and Recurring Schedules

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `templates.list` | `Remote<ReadonlyArray<TemplateView>>` (bounded, no cursor), schedule state badges (active, paused after failure, ended), "Use" quick action | `GET ws/templates`, `POST ws/templates/{id}/use`, archive (optimistic with Undo) | 4.1, 4.2, 4.5 |
| `templates.editor` | same line editor and live totals as screen 10 (shared `LinesEditor` sub-program), relative due (`inDays`), name | `GET/POST/PATCH ws/templates[/{id}]` with If-Match | 4.1 |
| `templates.schedule` | cadence (weeks, months, years), start, end, issue as invoice or proforma, auto send; next three dates and period text preview (flow 4.3) from `nextOccurrences` in `/engines` (AG-HTTP-ASKS item c, gap G6) | `PUT ws/templates/{id}/schedule` with If-Match; `null` detaches | 4.3, 4.5 |
| `templates.runs` | run history per occurrence: issued document, sent, failed with reason; "Resume" clears a failure pause | `GET ws/templates/{id}/runs` (gap G12), `POST ws/templates/{id}/resume` | 4.4, 4.5 |

Gate: `template.write`, `schedule.write`. Mobile: native editors (full parity, decision 16) under More.

### 8.13 Screen 13: Expenses list and quick capture

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `expenses.list` | `Paged<ExpenseSummary, ExpenseListQuery>` (period, category, tag, status, supplier, incomplete, text); queued capture jobs for this Workspace shown on top as rows with "Uploading 40 %", "Queued", or "Needs attention"; drop target on web | `GET ws/expenses?...` | 5.5, 5.2 |
| `expenses.capture` | camera with edge guides, multi-shot, gallery, files, incoming share; validates type and size against `config` before queueing; creates a `CaptureJob` and opens the Expense editor bound to it | `Capture.*`, `Ids.requestKey`, then the queue (section 6) | 5.2 |
| `captureQueue` (Shell child) | section 6 | section 6 | 5.2 |

States: offline banner on the list keeps capture enabled; jobs in `Blocked` show the reason and "Open"; empty state CTA "Snap your first receipt" on mobile, "Drop a PDF here" on web. Mobile: M12, M14.

### 8.14 Screen 14: Expense editor, detail and attachment viewer

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `expenses.editor` | supplier by Contact search or IČO (ARES prefill), number, dates, currency, category, tags, VAT breakdown rows entered from the received document; `VatMath` checks the sum equals gross and shows the difference live (core checks, never recalculates); FX for non-CZK from `GET ws/fx-rates/{currency}?on=` with CZK equivalent; bound to a capture job (`job` route param) when opened from capture, in which case save writes `job.fields` and the queue submits | `POST ws/expenses` (Idempotency-Key), `PATCH ws/expenses/{id}` (If-Match), `POST ws/contacts/from-ico` | 5.1, 5.3 |
| `expenses.detail` | view with attachments, payment state, payments list, "Mark paid" or partial Payment (reuses `documents.payment` with an expense target), remove (Confirm, If-Match) | `GET ws/expenses/{id}`, `POST ws/payments`, `DELETE ws/expenses/{id}` | 5.3, 5.4 |
| `expenses.attachmentViewer` | PDF and image viewer with pinch zoom, page count, download, detach (Confirm); add more files | `GET ws/expenses/{id}/attachments/{aid}?disposition=inline`, `POST .../attachments`, `DELETE .../attachments/{aid}` | 5.3 |

States: Incomplete badge and filter; editor side by side with the attachment on expanded web and stacked on mobile; Stale on edit; `Invalid{attachment.type_rejected}` lists allowed types. Gate `expense.write`, `expense.attachment.read`. Mobile: M13.

### 8.15 Screen 15: Contacts list, detail and editor

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `contacts.list` | `Paged<ContactSummary, ContactListQuery>` (text, role customer or supplier, archived) with live search (debounced, keyed) | `GET ws/contacts?...` | 6.3 |
| `contacts.detail` | particulars, VAT ids, billing overrides (`ContactView.defaults`, each shown as its own value or "Workspace default"), document and expense history (filtered lists), "New Invoice for this Contact", archive (optimistic, Undo), "Refresh from ARES" | `GET ws/contacts/{id}`, `GET ws/documents?contact=`, `GET ws/expenses?supplier=` | 6.3 |
| `contacts.editor` | IČO lookup first (checksum, then ARES prefill), manual entry path, billing and VAT details, invoicing emails, a "Billing defaults" section editing `ContactInput.defaults` (below); duplicate IČO shows `Conflict{duplicate}` with a link to the existing Contact | `GET /api/v1/registry/companies/{ico}`, `POST ws/contacts/from-ico`, `POST ws/contacts`, `PUT ws/contacts/{id}` (If-Match) | 6.1, 6.2, 6.3 |

The editor also runs embedded in the Document Editor's side panel (flow 3.1 branch) and returns `ContactCreatedInline`. Gate `contact.write`. Mobile: M15, M16.

Per-Contact billing overrides (screen 19, core-ports section 4.2, http-mcp-contracts section 3.5.4). The types are core's `ContactInput.defaults`, re-exported by `@kvitbit/api-contract`; field names and types are copied exactly:

```ts
export type ReminderPolicy =
  | { readonly mode: "inherit" }                                         // follow the Workspace reminder schedule
  | { readonly mode: "disabled" }                                        // no automatic reminders for this Contact
  | { readonly mode: "custom"; readonly offsetsDays: ReadonlyArray<number> }
export interface ContactDefaults {                                       // every field optional; absent = Workspace value
  readonly currency?: CurrencyCode
  readonly language?: Locale
  readonly dueDays?: number
  readonly paymentMethod?: PaymentMethod
  readonly preferredSeriesByKind?: Partial<Record<DocumentKind, NumberingSeriesId>>
  readonly defaultNote?: string
  readonly reminderPolicy?: ReminderPolicy                               // absent behaves as { mode: "inherit" }
}
```

Each field in the "Billing defaults" section has a "Use Workspace default" state that clears the field and shows the Workspace value as a hint. `reminderPolicy` is a three-way choice (`inherit`, `disabled`, `custom`); `custom` reveals a day-offset list with the same editor as `settings.reminders`. `documents.editor` prefills currency, language, due date, payment method, series and note along `Document → Contact → Workspace` when a Contact is picked (series from `preferredSeriesByKind[kind]`, which may name any subset of kinds; a missing kind uses the Workspace default series), sends a changed payment method as `DocumentInput.paymentMethod` / `DocumentPatch.paymentMethod`, and leaves the server to apply the same fallback on save; a value the Member typed on the Document always wins.

### 8.16 Screen 16: Price List

| | |
|---|---|
| Presenter | `priceList` |
| Model | `items: Remote<ReadonlyArray<PriceListItemView>>` (bounded), `text`, `editing: Option<{ id: Option<PriceListItemId>; form }>` (inline row on web, bottom sheet on mobile), `includeArchived` |
| Commands | `GET ws/price-list?text&includeArchived`, `POST/PATCH ws/price-list[/{id}]` (If-Match on existing), archive (optimistic, Undo) |
| States | empty CTA "Add your first item"; VAT treatment picker shows `VatMath.rateFor` for today; currency default |
| Flows | 6.4 |

### 8.17 Screen 17: Reports suite

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `reports.suite` | tabs revenue, expenses, cashflow, receivables (unpaid and overdue), VAT summary; `period`, `groupBy`; each tab `Remote<ReportView>`; charts get series data in the ViewModel (adapters draw); `non_vat_payer` VAT tab shows the threshold hint with turnover so far this year (Q11) | `GET ws/reports/{report}?from&to&groupBy` (`Reports.run`) | 9.2, 9.3, 9.4, 9.5, 9.6 |
| `reports.export` | format CSV or PDF, period, report; download with progress | `GET ws/reports/{report}/export?format=` via `Transfer.download` | 9.7 |

Gap: core `ReportQuery.report` has `revenue`, `vat_summary`, `receivables`, `expenses`, `profit` but no `cashflow`; the Cashflow tab needs a core report kind (G2). Mobile: M17 (summary cards per report, full tables on expanded).

### 8.18 Screen 18: Issuing Entity, Tax Regime, bank accounts, branding

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `settings.issuingEntity` | entity particulars, §435 register entry, IČO with ARES refresh | `GET ws`, `PATCH ws/issuing-entity` (If-Match) | 10.1 |
| `settings.taxRegime` | current regime, change with `effectiveFrom` date; explains that earlier documents keep the old regime (core W2); Confirm | `PATCH ws/issuing-entity` with regime change (If-Match) | 10.2 |
| `settings.bankAccounts` | list (bounded), add or edit IBAN, BIC, currency, default per currency; warns when a currency used by recent documents has no account | `GET/POST/PATCH ws/bank-accounts[/{id}]` | 10.3 |
| `settings.branding` | logo and stamp upload (2 MB PNG or JPEG), default PDF template, accent colour, footer text, Workspace theme (`ThemeSource` editor shared with Appearance, section 8.22); live PDF preview | `GET/PATCH ws/branding` (If-Match), `PUT/DELETE ws/branding/{logo\|stamp}`, `POST ws/branding/preview-pdf` (debounced 800 ms, AG-HTTP-ASKS), `POST /api/v1/themes/resolve` | 10.4 |

Gate: `workspace.settings` (owner, admin). Members and accountants see read-only values. Mobile: native under More, Settings.

### 8.19 Screen 19: Numbering Series, document defaults, reminders

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `settings.numbering` | per kind: series list, default flag, pattern editor with token chips, next three numbers from `Numbering.parsePattern` and `format` using the series' next counter (gap G7), `numbering.pattern_invalid` inline | `GET ws/numbering-series`, `POST/PATCH ws/numbering-series[/{id}]` | 10.5 |
| `settings.documentDefaults` | Workspace-level due days, default language, default PDF template, payment method (Contacts may override these, section 8.15), CZ and EN email texts with placeholders and preview (8.25) | `PATCH ws/settings` (If-Match) | 10.6 |
| `settings.reminders` | enable, day offsets, CZ and EN reminder texts with placeholder preview; Contacts whose `reminderPolicy` is `disabled` or `custom` override this schedule (section 8.15) | `PATCH ws/settings` (If-Match) | 7.5, 7.3 (policy) |

Gate `workspace.settings`.

### 8.20 Screen 20: Team, roles, invitations, danger zone

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `settings.team` | members with roles, pending invitations, invite (email and role, never owner), change role and remove (Confirm), revoke invitation, leave Workspace (for non-owners) | `GET ws/members`, `GET ws/invitations` (gap G9), `POST ws/invitations` (Idempotency-Key), `DELETE ws/invitations/{id}`, `POST ws/invitations/{id}/resend`, `PUT ws/members/{userId}/role`, `DELETE ws/members/{userId}`, `POST ws/members/me/leave` | 2.4, 2.6, 2.7 |
| `settings.dangerZone` | transfer ownership (pick an admin or member, Confirm; caller becomes admin), close Workspace (`TypeToConfirm` with the Workspace name), 10-year retention notice and export | `POST ws/ownership-transfer`, `POST ws/close` | 2.8, 2.9 |

States: last owner protection (`Conflict{illegal_transition}`) explained inline; a closed Workspace is read-only everywhere (core W5). Gate `member.invite`, `member.setRole`, `member.manageAdmins` (offer the `admin` role and admin rows only to the owner), `member.leave`, `workspace.transferOwnership`, `workspace.close`.

### 8.21 Screen 21: API Keys and connected MCP apps

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `settings.apiKeys` | list with name, access (`read`, `read_write` or `custom` with its per-area scopes), created, last used; create dialog (name, expiry, `ScopePickerState` capped by role) posts `ApiKeyCreate` and shows the secret once with Copy and a "I stored it" confirmation; revoke (Confirm) | `GET/POST ws/api-keys`, `DELETE ws/api-keys/{keyId}` | 10.7 |
| `settings.connectedApps` | grants with client name, Member, access mode and per-area scopes (`GrantedAccess`), created, last used; own grants for everyone, all grants for owner and admin; revoke (Confirm) | `GET ws/connected-apps`, `DELETE ws/connected-apps/{grantId}` | 10.9, 10.8 outcome |

API Key creation and MCP consent (screen 05) share one scope picker over the ten `ScopeArea`s. `ScopeArea`, `Scope` (`<area>:<read|write>`), `AccessMode`, `AccessRequest`, `GrantedAccess` and `ApiKeyCreate` are the http-mcp-contracts section 2.2 and 3.5.3 schemas from `@kvitbit/api-contract`:

```ts
export interface ScopePickerState {
  readonly mode: AccessMode                      // "read" | "read_write" | "custom"; presets are quick picks
  readonly selected: ReadonlySet<Scope>          // used when mode is "custom"; checking <area>:write also checks <area>:read
  readonly grantable: ReadonlySet<Scope>         // ceiling (API Keys: creator's role cap; consent: the Workspace's offerableScopes = request ∩ role cap)
}
/** Pure. Presets map to { access }; custom maps to { access: "custom", scopes }, None while empty (submit disabled).
 *  Scopes outside grantable cannot be checked; the server still answers Forbidden{grant.create} or Invalid if they arrive. */
export const toAccessRequest: (s: ScopePickerState) => Option.Option<AccessRequest>
/** Pure. Renders a stored grant as one row per area: "Read", "Read and write" or "No access". */
export const describeAccess: (g: GrantedAccess) => ReadonlyArray<{ readonly area: ScopeArea; readonly level: "none" | "read" | "write" }>
```

The API key secret is held only in the dialog Model and is not encoded into any persisted state (its Model field is excluded from the RN restore snapshot).

### 8.22 Screen 22: Account and security

| Presenter | Model and behaviour | Commands | Flows |
|---|---|---|---|
| `account.profile` | name, UI language (cs, en), email change (verification sent to the new address) | `auth/update-user`, `PATCH /api/v1/me/preferences { locale }`, `auth/change-email` | 1.8 |
| `account.appearance` | theme mode, style (segmented control "Elegant" / "Cozy" with a sample card, button and badge per option; picking one sets `draft.style` and previews immediately through `effectiveTheme`; Save sends the full `theme` preference, including `style`, in the preferences PATCH), contrast, dynamic colour switch (Android only), source picker: presets grid, seed colour field with live preview, Material Theme Builder file import with parse result, warnings and contrast check; "Follow Workspace theme" (source null) | `GET/PATCH /api/v1/me/preferences` (If-Match), `POST /api/v1/themes/resolve` (debounced 300 ms) | 1.8 (theme requirement) |
| `account.security` | passkeys list (add with name, rename, remove; removing the last sign-in method is blocked), change password with "sign out other sessions", sessions list with revoke | `AuthClient.passkey*`, `changePassword`, `sessions`, `revokeSession` | 1.5 (add), 1.8 |
| `account.danger` | delete account (soft delete, Q7) with `TypeToConfirm`; blocked while the user is the only owner of a Workspace, with links to transfer or close | `auth/delete-user` | 1.9 |

Appearance Model:

```ts
export interface AppearanceModel {
  readonly prefs: Remote<AccountPreferences>
  readonly draft: ThemeDraft                       // mode, style, contrast, dynamicColor, source
  readonly file: Option.Option<Either.Either<ParsedThemeFile, Invalid>>
  readonly resolved: Remote<ResolvedTheme>         // preview of draft.source
  readonly contrastWarnings: ReadonlyArray<{ readonly scheme: string; readonly pair: string; readonly ratio: number }>
  readonly save: Form<ThemeDraft, PreferencesPatch>["submit"]
}
```

While editing, the Shell's `ThemeState.draft` is set so the whole app previews the theme; Cancel restores it. Mobile: M19.

### 8.23 Screen 23: PDF template, Classic Czech

Rendered by core's `PdfRenderer` on the server. ui-port's part is the shared `shared.pdfPreview` presenter used by Document Detail, the Issue dialog, Branding and the Public Share Link:

```ts
export interface PdfPreviewModel {
  readonly source:
    | { readonly _tag: "Document"; readonly id: DocumentId; readonly revision: number }
    | { readonly _tag: "Share"; readonly token: ShareToken }
    | { readonly _tag: "Branding"; readonly patch: BrandingPatch; readonly kind: DocumentKind }
  readonly template: PdfTemplate                     // core: "classic" | "modern_minimal" (gap G1, resolved)
  readonly language: Locale
  readonly file: Remote<LocalFile>                   // fetched with ?disposition=inline, keyed by source+template+language
  readonly page: number
  readonly pages: Option.Option<number>
}
```

Template and language pickers re-fetch with a keyed Command; core caches per revision, template and language. Flow 3.10.

### 8.24 Screen 24: PDF template, Modern Minimal, and report export PDF

Same `shared.pdfPreview` with the second template, plus `reports.export` (section 8.17) for the report PDF. No new presenter. Flows 3.10, 9.7.

### 8.25 Screen 25: Email templates suite

Emails E01 to E08 are rendered by the server. ui-port provides `shared.emailCopyPreview`, used where Members edit or send copy (Document defaults 8.19, reminders 8.19, Send dialog 8.11):

```ts
export interface EmailCopyPreviewModel {
  readonly purpose: "document" | "reminder"
  readonly language: Locale
  readonly subject: string                            // template with placeholders as typed
  readonly body: string
  readonly sample: EmailSample                        // from the current document, or a fixed sample in settings
}
/** Pure: substitutes {number}, {amount}, {dueOn}, {link}, {issuer}, {contact}; unknown placeholders flagged. */
export const renderEmailCopy: (m: EmailCopyPreviewModel) => { readonly subject: string; readonly body: string; readonly unknown: ReadonlyArray<string> }
```

The preview shows text inside a neutral frame; the branded HTML layout stays server-only. Auth emails (E01 verify, E02 magic link, E03 reset, E04 invite, E07 email change, E08 needs attention) have no in-app editor in v1; ui-port only shows their outcomes (check-email screens, invitation state, failed-run attention in 8.12).

---

## 9. Traceability

### 9.1 Flows to presenters

Every flow heading in `user-flows.md` section 3 (72 in total) maps to at least one presenter. System flows have no screen of their own; the table names where their results show.

| Flow | Presenters | Key Messages and Commands |
|---|---|---|
| 1.1 Landing and legal | `public.landing`, `public.legal` | `GotLegal` |
| 1.2 Sign up with ALTCHA and verification | `auth.signUp`, `auth.checkEmail`, `auth.link` | `BotProofSolved`, `SubmittedForm` (`X-Altcha`), `ClickedResend` |
| 1.3 Log in with password | `auth.signIn` | `SubmittedForm`, `returnTo`, ALTCHA after failures |
| 1.4 Log in with magic link | `auth.signIn` (magic mode), `auth.link` | `sendMagicLink`, `verifyLink`, App Link via `DeepLinks` |
| 1.5 Passkey log in and add | `auth.signIn`, `account.security` | `ClickedPasskey`, `PasskeyBridge.get/create` |
| 1.6 Reset password | `auth.resetPassword`, `auth.link` | `requestPasswordReset`, `resetPassword` |
| 1.7 Install the mobile app | `public.androidDownload` | `GotRelease` |
| 1.8 Manage account and security | `account.profile`, `account.appearance`, `account.security` | preferences PATCH, passkeys, sessions |
| 1.9 Delete account | `account.danger` | `TypeToConfirm`, `deleteAccount` |
| 1.10 Log out | `shell.app` | `ClickedSignOut` |
| 2.1 Onboarding | `onboarding.wizard` | `GotAres`, `SubmittedWizard` |
| 2.2 Create another Workspace | `onboarding.wizard` from `shell.workspaceSwitcher` | `ClickedCreateWorkspace` |
| 2.3 Switch Workspace | `shell.workspaceSwitcher` | `PickedWorkspace` |
| 2.4 Invite a Member | `settings.team` | invite POST |
| 2.5 Accept an invitation | `invitation.landing` | accept POST |
| 2.6 Change role or remove | `settings.team` | `PUT ws/members/{userId}/role`, `DELETE ws/members/{userId}` |
| 2.7 Leave a Workspace | `settings.team` | leave (remove self) |
| 2.8 Transfer ownership | `settings.dangerZone` | transfer POST |
| 2.9 Delete a Workspace | `settings.dangerZone` | close POST |
| 3.1 Create an Invoice draft | `documents.editor`, `contacts.editor` (inline) | `ChangedField`, `GotPreview`, autosave |
| 3.2 Issue a document | `documents.issue`, `documents.detail` | issue POST, number preview |
| 3.3 Send by email | `documents.send`, `shared.emailCopyPreview` | deliveries POST |
| 3.4 Edit an issued, unlocked document | `documents.editor` (Issued mode) | `PATCH` with If-Match, `total_below_payments` warning |
| 3.5 Lock and unlock | `documents.detail`, `documents.list` badge | lock PUT/DELETE, `Confirm "document.unlock"` |
| 3.6 View history | `documents.history` | history GET |
| 3.7 Delete a draft, duplicate | `documents.list`, `documents.editor`, `documents.cancel` | discard DELETE, `DocumentNew { from: Duplicate }` |
| 3.8 Proforma settlement | `documents.payment`, `documents.settlement` | `splitAdvance`, final-invoice POST |
| 3.9 Credit Note | `documents.creditNote`, `documents.cancel` | credit-notes POST |
| 3.10 PDF, template, language | `shared.pdfPreview`, `documents.detail` | keyed PDF fetch |
| 3.11 Foreign-currency document | `documents.editor` FX panel | preview FX, manual rate |
| 4.1 Create an Invoice Template | `templates.editor`, `templates.list` | templates POST/PATCH |
| 4.2 Create from a Template | `documents.editor` (`from: Template`), `templates.list` | templates use POST |
| 4.3 Set up a Recurring Schedule | `templates.schedule` | schedule PUT, `nextOccurrences` |
| 4.4 Recurring run (System) | `templates.runs`, `documents.list`, `dashboard` | runs GET, issued documents appear |
| 4.5 Pause, resume, end, fix failed run | `templates.schedule`, `templates.runs` | schedule null, resume POST |
| 5.1 Record an Expense | `expenses.editor` | expenses POST |
| 5.2 Capture from photo or PDF | `expenses.capture`, `captureQueue`, `expenses.list` | `CaptureJob`, replay protocol |
| 5.3 Edit an Expense and attachments | `expenses.editor`, `expenses.attachmentViewer` | PATCH, attach, detach |
| 5.4 Mark paid or partial Payment | `expenses.detail`, `documents.payment` (expense target) | payments POST |
| 5.5 Browse and filter Expenses | `expenses.list` | paged GET |
| 6.1 Contact with ARES | `contacts.editor` | registry GET, from-ico POST |
| 6.2 Contact manually | `contacts.editor` | contacts POST |
| 6.3 Edit, refresh, archive Contact | `contacts.detail`, `contacts.editor`, `contacts.list` | PATCH, archive |
| 6.4 Price List Items | `priceList` | price-list POST/PATCH |
| 7.1 Record a Payment | `documents.payment` | payments POST |
| 7.2 Remove or correct a Payment | `documents.payment` | payments DELETE with reason |
| 7.3 Automatic reminders (System) | `documents.history` (reminder deliveries), `documents.detail` deliveries, `settings.reminders` | n/a |
| 7.4 Manual reminder | `documents.send` (purpose reminder) | deliveries POST `{ purpose: "reminder" }` |
| 7.5 Configure reminders | `settings.reminders`, `shared.emailCopyPreview` | settings PATCH |
| 8.1 Copy or share the link | `documents.share` | share-link PUT, Clipboard, ShareSheet |
| 8.2 Recipient views | `share.view` | share GET |
| 8.3 Recipient pays with QR | `share.view` | `PaymentQr.toSvg`, copy fields |
| 8.4 Recipient downloads PDF | `share.view` | share PDF GET |
| 8.5 Revoke or regenerate | `documents.share`, `share.view` (revoked) | share-link DELETE then PUT |
| 8.6 View tracking | `documents.detail`, `documents.history`, `documents.list`, `dashboard` | view counts from `DocumentView.share` |
| 9.1 Dashboard | `dashboard` | reports dashboard GET |
| 9.2 Revenue | `reports.suite` | reports GET |
| 9.3 Expense report | `reports.suite` | reports GET |
| 9.4 Cashflow | `reports.suite`, `dashboard` | reports GET (gap G2) |
| 9.5 Unpaid and overdue | `reports.suite` (receivables) | reports GET |
| 9.6 VAT summary | `reports.suite` | reports GET, threshold hint |
| 9.7 Export | `reports.export`, `shared.pdfPreview` | export download |
| 10.1 Issuing Entity | `settings.issuingEntity` | PATCH |
| 10.2 Tax Regime | `settings.taxRegime` | PATCH with `effectiveFrom` |
| 10.3 Bank accounts | `settings.bankAccounts` | POST/PATCH |
| 10.4 Branding and PDF template | `settings.branding`, `shared.pdfPreview` | branding PATCH, preview-pdf POST |
| 10.5 Numbering Series | `settings.numbering` | series POST/PATCH, `Numbering.*` |
| 10.6 Defaults and email texts | `settings.documentDefaults`, `shared.emailCopyPreview` | settings PATCH |
| 10.7 API Keys | `settings.apiKeys` | api-keys GET/POST/DELETE |
| 10.8 MCP consent | `mcp.consent`, `settings.connectedApps` | consents GET/POST |
| 10.9 Connected apps | `settings.connectedApps` | connected-apps GET/DELETE |
| 10.10 Work through MCP | none (MCP only); results show in `documents.history` ("via <client>") | n/a |

### 9.2 Mobile screens to presenters

| Mobile | Presenters |
|---|---|
| M01 Sign in | `auth.signIn`, `auth.link` |
| M02 Sign up and verification | `auth.signUp`, `auth.checkEmail` |
| M03 Workspace wizard | `onboarding.wizard` |
| M04 Home dashboard | `dashboard` |
| M05 Documents list | `documents.list` |
| M06 Document detail with PDF | `documents.detail`, `shared.pdfPreview`, `documents.history` |
| M07 Document editor, quick start | `documents.editor` |
| M08 Send and share sheet | `documents.send`, `documents.share` |
| M09 Record Payment sheet | `documents.payment` |
| M10 Proforma settlement sheet | `documents.settlement` |
| M11 Credit Note start sheet | `documents.creditNote`, `documents.cancel` |
| M12 Expense capture | `expenses.capture`, `captureQueue` |
| M13 Expense editor | `expenses.editor`, `expenses.attachmentViewer` |
| M14 Expenses list | `expenses.list` |
| M15 Contacts list and detail | `contacts.list`, `contacts.detail` |
| M16 Contact editor with ARES | `contacts.editor` |
| M17 Reports summary | `reports.suite`, `reports.export` |
| M18 More tab and switcher | `shell.app`, `shell.workspaceSwitcher`, and the parity screens: `templates.*`, `priceList`, `settings.*` |
| M19 Account and security | `account.profile`, `account.appearance`, `account.security`, `account.danger` |

The "Open on web" links in `user-flows.md` 2.2 are obsolete under decision 16: every presenter runs natively in `apps/mobile`.

### 9.3 Screens to presenters (count)

| Screen | Presenters | Count |
|---|---|---|
| 01 | `public.landing`, `public.legal` | 2 |
| 02 | `auth.signUp`, `auth.signIn`, `auth.checkEmail`, `auth.link`, `auth.resetPassword` | 5 |
| 03 | `public.androidDownload`, `public.error` | 2 |
| 04 | `share.view` | 1 |
| 05 | `mcp.consent`, `invitation.landing` | 2 |
| 06 | `shell.app`, `shell.workspaceSwitcher` | 2 |
| 07 | `onboarding.wizard` | 1 |
| 08 | `dashboard` | 1 |
| 09 | `documents.list` | 1 |
| 10 | `documents.editor` | 1 |
| 11 | `documents.detail`, `.issue`, `.send`, `.payment`, `.settlement`, `.creditNote`, `.cancel`, `.share`, `.history` | 9 |
| 12 | `templates.list`, `.editor`, `.schedule`, `.runs` | 4 |
| 13 | `expenses.list`, `expenses.capture`, `captureQueue` | 3 |
| 14 | `expenses.editor`, `.detail`, `.attachmentViewer` | 3 |
| 15 | `contacts.list`, `.detail`, `.editor` | 3 |
| 16 | `priceList` | 1 |
| 17 | `reports.suite`, `reports.export` | 2 |
| 18 | `settings.issuingEntity`, `.taxRegime`, `.bankAccounts`, `.branding` | 4 |
| 19 | `settings.numbering`, `.documentDefaults`, `.reminders` | 3 |
| 20 | `settings.team`, `settings.dangerZone` | 2 |
| 21 | `settings.apiKeys`, `settings.connectedApps` | 2 |
| 22 | `account.profile`, `.appearance`, `.security`, `.danger` | 4 |
| 23 | `shared.pdfPreview` | 1 |
| 24 | reuses `shared.pdfPreview`, `reports.export` | 0 |
| 25 | `shared.emailCopyPreview` | 1 |
| Total | | 60 |

---

## 10. Peer agreements with http-mcp-contracts (#19)

Board channel `invoicarr/adapter-contracts`, board path `/home/dev/.t3/projects/invoicarr` (pre-rename coordination IDs matching the GitHub repo `totalolage/invoicarr`, a bootstrapped infra ID, kept). Message ids are board ids.

| Agreement | Board message | Terms used in this spec |
|---|---|---|
| AG-UI-1 | #28 (reply to #27) | `Api` from `packages/api-contract`, prefix `/api/v1`, core Schema views unchanged; cursor plus `limit` 1 to 100 (default 50), filter-bound cursor, `Invalid{page.cursor_mismatch}`, plain arrays for bounded collections, fixed sort; strong `ETag "<revision>"`, `If-Match` required on expectedRevision operations, 428 and 412 `PreconditionFailed{currentRevision}`, one `StaleRevision` state; one UUIDv7 `Idempotency-Key` per intent, `Idempotent-Replayed`; multipart part `file`, attachments 20 MB PDF/JPEG/PNG/HEIC, branding 2 MB PNG/JPEG, plain GET downloads with `?disposition=inline`, no signed URLs, cookie on web and bearer on Expo; wire errors including 401, 413, 429; `Accept-Language` with account preference winning |
| AG-HTTP-THEME | #31 (reply to #27, supersedes P6 and U7) | `ThemeSource` (Preset, Seed, MaterialThemeBuilder), `ThemePresets`, `ThemeContrast`, `ThemeMode`, `ThemeStyle` (`"elegant" | "cozy"`, default `"elegant"`), `ResolvedTheme` with six schemes and harmonized `paid`/`proforma`/`overdue`/`draft`; `GET/PATCH /api/v1/me/preferences` with `dynamicColor`; `GET/PATCH ws/branding` with `theme`; `POST /api/v1/themes/resolve`; precedence dynamic, account, workspace, default; ui-port bundles no colour library |
| AG-UI-2 | #33 (reply to #25) | `@kvitbit/api-contract` npm name; ARES prefill and from-ico; FX lookup; ALTCHA challenge route, `X-Altcha`, `InvalidBotProof`, `204` for Noop; Better Auth route set; API keys; connected apps; OAuth consent routes; invitation by token; Android release info; no activity feed in v1; `GET /api/v1/config` |
| AG-HTTP-ASKS | #36 (reply to #25) | `POST ws/branding/preview-pdf`; manual reminder as `POST ws/documents/{id}/deliveries { purpose: "reminder" }`; `nextOccurrences` as a pure engine, no endpoint; `GET ws/reports/dashboard` kept in the contract with a core gap, composed from three reports until then |

Route names used in section 8 that the agreements do not spell out (for example `ws/members`, `ws/numbering-series`, `ws/templates/{id}/runs`) follow core method names; #19's `http-mcp-contracts.md` is the authority for their final spelling, and ui-port reaches them only through the typed `Api`, so a rename is a compile error, not a silent break.

---

## 11. Gaps and open decisions

Core gaps found while mapping screens to `core-ports.md`. None changes the ui-port architecture. Status: G1 to G10 and G12 are resolved in `core-ports.md` section 14 (G1 as `modern_minimal`, G2 as `cashflow` plus `Reports.dashboard`); G11, G13 and G14 need no core change.

| Id | Gap | Affects | Proposal |
|---|---|---|---|
| G1 | `PdfTemplate = "classic" \| "compact"` but screens 23 and 24 are "Classic Czech" and "Modern Minimal" | 8.23, 8.24, 8.18 | rename `compact` to `modern` in core, or keep the id and label it "Modern Minimal" in i18n (ui-port works with either) |
| G2 | `ReportQuery.report` has no `cashflow` and no `dashboard` | 8.8, 8.17 | add both kinds to core (#19 flags `dashboard` too) |
| G3 | No manual FX rate in `DocumentInput` (decision Q4, flow 3.11 branches) | 8.10 | add `fx?: { manual: { rate, quantity } }` to `DocumentInput` and `DocumentPatch`; audit records it |
| G4 | Expense "Incomplete" save (flow 5.2) and an `incomplete` filter in `ExpenseQuery` not confirmed in core | 6.2, 8.13, 8.14 | `ExpenseInput` accepts a minimal record with `status: "incomplete"`; `ExpenseQuery.incomplete` |
| G5 | `SendOptions` lacks `purpose` (flow 7.4) | 8.11 | add `purpose: "document" \| "reminder"` (#19 flagged it, AG-HTTP-ASKS) |
| G6 | No pure `nextOccurrences` in `/engines` (flow 4.3 preview) | 8.12 | add `Schedules.nextOccurrences(schedule, from, n)` to `@kvitbit/core/engines`, shared with the core sweep |
| G7 | `NumberingSeriesView` must expose the next counter for the current period | 8.11 issue dialog, 8.19 | add `nextCounter` and `periodKey` to the view |
| G8 | ARES read-only prefill and invitation peek need core read methods | 8.7, 8.15, 8.5 | flagged by #19 (AG-UI-2) |
| G9 | `Workspaces` has no `listMembers` or `listInvitations` | 8.20 | add both reads, or include them in `WorkspaceView` for `member.invite` holders |
| G10 | Workspace slug: `WorkspaceSummary` must carry a unique `slug` (flow rule: URLs carry the slug) | 2.10 | add `slug` to `WorkspaceSummary` and `WorkspaceView` |
| G11 | Legal page templates route (EN/CZ configurable) | 8.1 | static SSR on web, or `GET /api/v1/legal/{page}`; #19 to decide |
| G12 | Recurring run history read (`templates.runs`) | 8.12 | add `Templates.runs(templateId)` returning occurrences with outcome |
| G13 | The brief counts 62 flows; `user-flows.md` has 72 flow headings | 9.1 | traced all 72; no action unless the parent meant a subset |
| G14 | Better Auth Expo session transport: AG-UI-1 says bearer on Expo, while `@better-auth/expo` stores a cookie by default | 5.1 | #19 owns the choice; ui-port is unaffected because credentials live in the adapter's HttpClient layer |

---

## 12. Assumptions and spellings to confirm

These do not change the design; confirm each during implementation.

- Foldkit 0.171: `Runtime.makeApplication` (or the current application constructor), the Command type as an Effect producing a Message, routing hooks for URL change and URL request, navigation commands for push and replace, keyed subscriptions, SSR render and hydrate entry points. ADR 0001 accepts that these may move with the planned Foldkit rebuild; `toFoldkit` is the only file that should change.
- `effect@4.1.4`: `Schema.toStandardSchemaV1` (Standard Schema V1 export), `Schema.Codec` as the two-sided Schema type, `HttpApiClient.make` import path, `Effect.catch` for catching all expected errors, `Stream` interop in subscriptions.
- `@ui-sdk/core` behaviours for combobox, listbox, menu, dialog and date grid exist with state that can be held externally (TEA-owned). If a behaviour keeps state internally only, the adapter wraps it and reports events as Messages.
- Expo libraries: `@pchmn/expo-material3-theme` (dynamic colour), `react-native-passkey` (Credential Manager), `react-native-altcha` plus `react-native-quick-crypto` (ADR 0002), `expo-share-intent` (share sheet), `expo-background-task`, `react-native-pdf`, `react-native-paper` v5 MD3. Each is a candidate; the port interfaces stay the same if a different library is chosen.
- Hermes `Intl.NumberFormat` and `Intl.DateTimeFormat` with `cs-CZ` locale data on Android (enable full ICU in the Expo build if the default is trimmed).
- Material Theme Builder export shape (keys `seed`, `coreColors`, `extendedColors`, `schemes` with contrast variants) as of the current Theme Builder; the parser ignores unknown keys.

---

## 13. Testing

| Layer | What | Where |
|---|---|---|
| Update | table-driven tests per presenter: given Model and Message, assert Model, command names and intents. No services needed (T1) | `packages/ui-port/src/screens/*/update.test.ts` |
| Commands | run Commands against `TestUiServices`: an `KvitbitApi` built from the real `Api` with handlers backed by `TestCore` (core-ports section 10), plus fake ports | `packages/ui-port/src/screens/*/commands.test.ts` |
| Program | `runProgram(program, flags, script)` drives Messages through update and Commands end to end, asserting the ViewModel after each step | per presenter |
| Engines in presenters | editor totals equal `Documents.preview` totals for the core's VAT table cases (drift test) | `documents/editor` |
| Routes | `toPath`/`fromPath` round trip property test; every route has a Foldkit path and an expo-router file | `routes.test.ts`, plus a script in `apps/mobile` checking the file tree |
| Theme | parser accepts real Theme Builder exports (fixtures), rejects oversized and malformed files with the server's codes; default theme snapshot equals the resolver output; WCAG contrast for every preset | `theme/*.test.ts` |
| Capture queue | crash at every step boundary gives exactly one Expense and one attachment per file hash (Q5); `NeedsSignIn` and `Blocked` transitions | `shell/captureQueue.test.ts` |
| Purity | dependency rule check (section 1) and a `tsconfig` without DOM types; a test that imports every presenter in a plain Node environment with no globals beyond ES2023 | CI |
| Adapters | Foldkit: SSR hydration round trip for public routes; Expo: `useProgram` interrupts commands on unmount; `LocalThemeEngine` equals the server resolver for a table of primaries | `apps/web`, `apps/mobile` |
