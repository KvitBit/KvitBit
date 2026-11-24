/**
 * Generic form state, ui-port-contracts 2.7. Forms keep the raw text the user typed and decode
 * it to the core input on blur and submit. Client issues come from decoding, server issues from
 * the last `Invalid`; both use the same codes (F1) and render as `issue.<code>`.
 *
 * The submit error type is a parameter so this module does not depend on the api area's
 * `UiError`; screens instantiate it with `UiError`.
 */
import { BigDecimal, Option, Result } from "effect";

/** Core paths joined with ".", e.g. "lines.2.unitPrice". */
export type FieldPath = string;

export interface FieldIssue {
  readonly path: FieldPath;
  /** A core `IssueCode` or a ui-only `form.*` code; the catalog key is `issue.<code>`. */
  readonly code: string;
  readonly params?: Readonly<Record<string, string>>;
}

export type SubmitState<E> =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Submitting"; readonly requestKey: Option.Option<string> }
  | { readonly _tag: "Failed"; readonly error: E; readonly requestKey: Option.Option<string> };

export interface Form<Draft, E = unknown> {
  readonly draft: Draft;
  readonly touched: ReadonlyArray<FieldPath>;
  readonly clientIssues: ReadonlyArray<FieldIssue>;
  readonly serverIssues: ReadonlyArray<FieldIssue>;
  readonly submit: SubmitState<E>;
  /** For If-Match; None on create. */
  readonly baseRevision: Option.Option<number>;
  /** Set after the first submit attempt: errors then show on untouched fields too (F2). */
  readonly submitted: boolean;
}

export interface FormSpec<Draft, Input, Ctx = void> {
  /** Draft text -> core input, with issues by path on failure. */
  readonly decode: (draft: Draft) => Result.Result<Input, ReadonlyArray<FieldIssue>>;
  /** Client-only rules the server also enforces. */
  readonly refine?: (input: Input, ctx: Ctx) => ReadonlyArray<FieldIssue>;
}

/** `path` equals `prefix` or lies below it ("lines.2.vat" is under "lines.2"). */
export const isUnder = (path: FieldPath, prefix: FieldPath): boolean =>
  path === prefix || path.startsWith(`${prefix}.`);

const setAt = (value: unknown, keys: ReadonlyArray<string>, next: unknown): unknown => {
  if (keys.length === 0) return next;
  const [head, ...tail] = keys as [string, ...Array<string>];
  if (Array.isArray(value)) {
    const index = Number(head);
    const copy = [...value];
    copy[index] = setAt(copy[index], tail, next);
    return copy;
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return { ...record, [head]: setAt(record[head], tail, next) };
};

/** Reads a value at a dotted path, undefined when absent. */
export const getAt = (value: unknown, path: FieldPath): unknown =>
  path === ""
    ? value
    : path
        .split(".")
        .reduce<unknown>(
          (acc, key) =>
            typeof acc === "object" && acc !== null
              ? (acc as Record<string, unknown>)[key]
              : undefined,
          value,
        );

const dedupe = (paths: ReadonlyArray<FieldPath>): ReadonlyArray<FieldPath> => [...new Set(paths)];

export const Form = {
  init: <D, E = unknown>(draft: D, baseRevision?: number): Form<D, E> => ({
    draft,
    touched: [],
    clientIssues: [],
    serverIssues: [],
    submit: { _tag: "Idle" },
    baseRevision: Option.fromNullishOr(baseRevision),
    submitted: false,
  }),
  /** Sets the raw value at `path` and clears server issues at or below it. */
  change: <D, E>(form: Form<D, E>, path: FieldPath, value: unknown): Form<D, E> => ({
    ...form,
    draft: setAt(form.draft, path === "" ? [] : path.split("."), value) as D,
    serverIssues: form.serverIssues.filter((i) => !isUnder(i.path, path)),
  }),
  /** Blur: marks the field touched and refreshes client issues. */
  blur: <D, I, C, E>(
    form: Form<D, E>,
    path: FieldPath,
    spec: FormSpec<D, I, C>,
    ctx: C,
  ): Form<D, E> => Form.check({ ...form, touched: dedupe([...form.touched, path]) }, spec, ctx),
  /** Recomputes client issues from the draft without touching anything. */
  check: <D, I, C, E>(form: Form<D, E>, spec: FormSpec<D, I, C>, ctx: C): Form<D, E> => ({
    ...form,
    clientIssues: Result.match(Form.decode(form, spec, ctx), {
      onSuccess: () => [],
      onFailure: (issues) => issues,
    }),
  }),
  decode: <D, I, C, E>(
    form: Form<D, E>,
    spec: FormSpec<D, I, C>,
    ctx: C,
  ): Result.Result<I, ReadonlyArray<FieldIssue>> =>
    Result.flatMap(spec.decode(form.draft), (input) => {
      const extra = spec.refine?.(input, ctx) ?? [];
      return extra.length === 0 ? Result.succeed(input) : Result.fail(extra);
    }),
  /**
   * Submit (F3): decodes the draft. Failure marks the form submitted (every issue shows) and
   * returns the form; success returns the input to send. Use `submitting` once the request starts.
   */
  validate: <D, I, C, E>(
    form: Form<D, E>,
    spec: FormSpec<D, I, C>,
    ctx: C,
  ): Result.Result<I, Form<D, E>> =>
    Result.mapError(Form.decode(form, spec, ctx), (issues) => ({
      ...form,
      clientIssues: issues,
      submitted: true,
      touched: dedupe([...form.touched, ...issues.map((i) => i.path)]),
    })),
  submitting: <D, E>(form: Form<D, E>, requestKey?: string): Form<D, E> => ({
    ...form,
    submitted: true,
    clientIssues: [],
    submit: { _tag: "Submitting", requestKey: Option.fromNullishOr(requestKey) },
  }),
  failed: <D, E>(form: Form<D, E>, error: E): Form<D, E> => ({
    ...form,
    submit: {
      _tag: "Failed",
      error,
      requestKey: form.submit._tag === "Idle" ? Option.none() : form.submit.requestKey,
    },
  }),
  /** Stores the server's field issues from an `Invalid` (paths are core paths). */
  applyServer: <D, E>(form: Form<D, E>, issues: ReadonlyArray<FieldIssue>): Form<D, E> => ({
    ...form,
    serverIssues: issues,
    submit: { _tag: "Idle" },
    submitted: true,
  }),
  /** A save succeeded: back to idle with the new revision. */
  saved: <D, E>(form: Form<D, E>, revision?: number): Form<D, E> => ({
    ...form,
    submit: { _tag: "Idle" },
    serverIssues: [],
    clientIssues: [],
    baseRevision: revision === undefined ? form.baseRevision : Option.some(revision),
  }),
  /** Issues to show at `path`: exact path or below it (F4). Untouched fields stay quiet (F2). */
  issuesAt: <D, E>(
    form: Form<D, E>,
    path: FieldPath,
    opts?: { readonly showUntouched?: boolean },
  ): ReadonlyArray<FieldIssue> => {
    const visible =
      opts?.showUntouched === true || form.submitted || form.touched.some((t) => isUnder(t, path));
    return visible
      ? [...form.clientIssues, ...form.serverIssues].filter((i) => isUnder(i.path, path))
      : [];
  },
  /** First issue path in `fieldOrder` to focus after a failed submit (F3). */
  firstErrorPath: <D, E>(
    form: Form<D, E>,
    fieldOrder: ReadonlyArray<FieldPath>,
  ): Option.Option<FieldPath> => {
    const all = [...form.clientIssues, ...form.serverIssues];
    return Option.fromNullishOr(
      fieldOrder.find((field) => all.some((i) => isUnder(i.path, field))) ?? all[0]?.path,
    );
  },
};

/**
 * Maps server issues onto the fields a screen shows (F4): exact path, else the longest shown
 * prefix ("lines.2" for "lines.2.vat" when the VAT control is hidden), else the form summary.
 */
export const mapServerIssues = (
  issues: ReadonlyArray<FieldIssue>,
  shownFields: ReadonlyArray<FieldPath>,
): {
  readonly byField: ReadonlyMap<FieldPath, ReadonlyArray<FieldIssue>>;
  readonly summary: ReadonlyArray<FieldIssue>;
} => {
  const byField = new Map<FieldPath, Array<FieldIssue>>();
  const summary: Array<FieldIssue> = [];
  for (const issue of issues) {
    const target = shownFields
      .filter((f) => isUnder(issue.path, f))
      .reduce<FieldPath | undefined>(
        (best, f) => (best === undefined || f.length > best.length ? f : best),
        undefined,
      );
    if (target === undefined) summary.push(issue);
    else byField.set(target, [...(byField.get(target) ?? []), issue]);
  }
  return { byField, summary };
};

/**
 * `DecimalText` (F5): accepts "," or "." as the decimal separator and spaces / NBSP / narrow
 * NBSP as group separators, at most `scale` decimals. Fails with `form.decimal_invalid`.
 */
export const parseDecimalText = (
  text: string,
  scale: number,
): Result.Result<BigDecimal.BigDecimal, "form.decimal_invalid" | "form.required"> => {
  const compact = text.replace(/[\s  ]/g, "");
  if (compact === "") return Result.fail("form.required");
  if (!/^-?\d+(?:[.,]\d+)?$/.test(compact)) return Result.fail("form.decimal_invalid");
  const [, fraction = ""] = compact.split(/[.,]/);
  if (fraction.length > scale) return Result.fail("form.decimal_invalid");
  return Option.match(BigDecimal.fromString(compact.replace(",", ".")), {
    onNone: () => Result.fail("form.decimal_invalid" as const),
    onSome: (value) => Result.succeed(BigDecimal.normalize(value)),
  });
};
