/**
 * Generic form state, ui-port-contracts 2.7. Forms keep the raw text the user typed and decode
 * it to the core input on blur and submit. Client issues come from decoding, server issues from
 * the last `Invalid`; both use the same codes (F1) and render as `issue.<code>`.
 *
 * The submit error type is a parameter so this module does not depend on the api area's
 * `UiError`; screens instantiate it with `UiError`.
 */
import type { Locale } from "@kvitbit/domain/contract";
import {
  BigDecimal,
  Effect,
  Equal,
  Option,
  Result,
  Schema,
  type SchemaAST,
  SchemaIssue,
  SchemaTransformation,
  type StandardSchema,
} from "effect";
import { isMessageKey } from "../i18n";

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

/** What every form call needs from the screen: the locale its decimals are typed in. */
export interface FormContext {
  readonly locale: Locale;
}

/**
 * One schema per locale, from draft text to the core input. Issue codes come from the schema: a
 * check or transformation annotated with `message: <IssueCode>` reports that code; a missing
 * key reports `form.required`.
 */
export interface FormSpec<Draft, Input, Ctx extends FormContext = FormContext> {
  /** Effect Schema from draft text to the core input; decimals use `DecimalText(locale)`. */
  readonly schema: (locale: Locale) => Schema.Codec<Input, Draft>;
  /** The same schema as a Standard Schema V1 validator, for adapter widgets (issue codes as messages). */
  readonly standard: (locale: Locale) => StandardSchema.StandardSchemaV1<Draft, Input>;
  /** Client-only rules the server also enforces. */
  readonly refine?: (input: Input, ctx: Ctx) => ReadonlyArray<FieldIssue>;
}

/**
 * The issue code of a failed leaf: its `message` annotation (`messageMissingKey` for a missing
 * key), else `form.required` for a missing key and `form.invalid` for anything else.
 */
const issueCode: SchemaIssue.LeafHook = (issue) => {
  const annotations = ("annotations" in issue ? issue.annotations : issue.ast.annotations) as
    | Readonly<Record<string, unknown>>
    | undefined;
  const message = annotations?.[issue._tag === "MissingKey" ? "messageMissingKey" : "message"];
  if (typeof message === "string") return message;
  return issue._tag === "MissingKey" ? "form.required" : "form.invalid";
};

/**
 * A message that is not a known issue code becomes `form.invalid` (F1). Effect bypasses the leaf
 * hook for some failures (an unannotated filter check, a literal choice), which then carry
 * English "Expected ..." text; annotated codes pass through.
 */
const toIssueCode = (message: string): string =>
  isMessageKey(`issue.${message}`) ? message : "form.invalid";

const toFieldPath = (
  path: ReadonlyArray<PropertyKey | StandardSchema.StandardSchemaV1.PathSegment> | undefined,
): FieldPath =>
  (path ?? [])
    .map((segment) => String(typeof segment === "object" ? segment.key : segment))
    .join(".");

export const FormSpec = {
  /** Builds `standard` from `schema`, so both always validate alike. */
  make: <Draft, Input, Ctx extends FormContext = FormContext>(options: {
    readonly schema: (locale: Locale) => Schema.Codec<Input, Draft>;
    readonly refine?: (input: Input, ctx: Ctx) => ReadonlyArray<FieldIssue>;
  }): FormSpec<Draft, Input, Ctx> => {
    const standard = (locale: Locale): StandardSchema.StandardSchemaV1<Draft, Input> => {
      const base = Schema.toStandardSchemaV1(options.schema(locale), {
        leafHook: issueCode,
        // every field's issue at once, as a submit shows them all (F3)
        parseOptions: { errors: "all" },
      }) as StandardSchema.StandardSchemaV1<Draft, Input>;
      const normalize = (
        result: StandardSchema.StandardSchemaV1.Result<Input>,
      ): StandardSchema.StandardSchemaV1.Result<Input> =>
        result.issues === undefined
          ? result
          : {
              issues: result.issues.map((issue) => ({
                ...issue,
                message: toIssueCode(issue.message),
              })),
            };
      return {
        "~standard": {
          ...base["~standard"],
          validate: (value) => {
            const result = base["~standard"].validate(value);
            return result instanceof Promise ? result.then(normalize) : normalize(result);
          },
        },
      };
    };
    return options.refine === undefined
      ? { schema: options.schema, standard }
      : { schema: options.schema, standard, refine: options.refine };
  },
  /** Draft -> input for `locale`, issues by core path. Form schemas must decode synchronously. */
  decode: <Draft, Input, Ctx extends FormContext>(
    spec: FormSpec<Draft, Input, Ctx>,
    draft: Draft,
    locale: Locale,
  ): Result.Result<Input, ReadonlyArray<FieldIssue>> => {
    const result = spec.standard(locale)["~standard"].validate(draft);
    if (result instanceof Promise) throw new Error("FormSpec schemas must decode synchronously");
    if (result.issues === undefined) return Result.succeed(result.value);
    return Result.fail(
      result.issues.map((issue) => ({ path: toFieldPath(issue.path), code: issue.message })),
    );
  },
};

/** A server issue as decoded (`Invalid.issues`): the path is a segment list. */
export interface ServerIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly code: string;
  readonly params?: Readonly<Record<string, string>> | undefined;
}

/** Joins a server issue's path with "." and keeps its code and params. */
export const fromServerIssue = (issue: ServerIssue): FieldIssue =>
  issue.params === undefined
    ? { path: issue.path.join("."), code: issue.code }
    : { path: issue.path.join("."), code: issue.code, params: issue.params };

const isFieldIssue = (issue: ServerIssue | FieldIssue): issue is FieldIssue =>
  typeof issue.path === "string";

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

const withoutKey = <E>(submit: SubmitState<E>): SubmitState<E> =>
  submit._tag === "Idle" ? submit : { ...submit, requestKey: Option.none() };

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
  /**
   * Sets the raw value at `path` and clears server issues at or below it. A real edit also drops
   * the intent's Idempotency-Key (section 2.3): the changed payload is a new intent, so it must not
   * replay or mismatch the old key. Setting a structurally equal value (a fresh array holding the
   * same lines) keeps it for an unchanged retry. The key is dropped on the first real edit, so
   * while it is kept the draft equals the one submitted under it.
   */
  change: <D, E>(form: Form<D, E>, path: FieldPath, value: unknown): Form<D, E> => {
    const edited = !Equal.equals(getAt(form.draft, path), value);
    return {
      ...form,
      draft: edited
        ? (setAt(form.draft, path === "" ? [] : path.split("."), value) as D)
        : form.draft,
      serverIssues: form.serverIssues.filter((i) => !isUnder(i.path, path)),
      submit: edited && form.submit._tag !== "Idle" ? withoutKey(form.submit) : form.submit,
    };
  },
  /** Blur: marks the field touched and refreshes client issues. */
  blur: <D, I, C extends FormContext, E>(
    form: Form<D, E>,
    path: FieldPath,
    spec: FormSpec<D, I, C>,
    ctx: C,
  ): Form<D, E> => Form.check({ ...form, touched: dedupe([...form.touched, path]) }, spec, ctx),
  /** Recomputes client issues from the draft without touching anything. */
  check: <D, I, C extends FormContext, E>(
    form: Form<D, E>,
    spec: FormSpec<D, I, C>,
    ctx: C,
  ): Form<D, E> => ({
    ...form,
    clientIssues: Result.match(Form.decode(form, spec, ctx), {
      onSuccess: () => [],
      onFailure: (issues) => issues,
    }),
  }),
  decode: <D, I, C extends FormContext, E>(
    form: Form<D, E>,
    spec: FormSpec<D, I, C>,
    ctx: C,
  ): Result.Result<I, ReadonlyArray<FieldIssue>> =>
    Result.flatMap(FormSpec.decode(spec, form.draft, ctx.locale), (input) => {
      const extra = spec.refine?.(input, ctx) ?? [];
      return extra.length === 0 ? Result.succeed(input) : Result.fail(extra);
    }),
  /**
   * Submit (F3): decodes the draft. Failure marks the form submitted (every issue shows) and
   * returns the form; success returns the input to send. Use `submitting` once the request starts.
   */
  validate: <D, I, C extends FormContext, E>(
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
  /**
   * Stores the server's field issues: pass the decoded `Invalid` itself (or its `issues`); paths
   * are joined with "." and codes and params kept. Already joined `FieldIssue`s pass through.
   */
  applyServer: <D, E>(
    form: Form<D, E>,
    invalid:
      | { readonly issues: ReadonlyArray<ServerIssue | FieldIssue> }
      | ReadonlyArray<ServerIssue | FieldIssue>,
  ): Form<D, E> => ({
    ...form,
    serverIssues: ("issues" in invalid ? invalid.issues : invalid).map((issue) =>
      isFieldIssue(issue) ? issue : fromServerIssue(issue),
    ),
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

const decimalIssue = (
  code: "form.decimal_invalid" | "form.required",
  input: string,
  options: SchemaAST.ParseOptions,
) => new SchemaIssue.InvalidValue({ message: code }, input, options);

/**
 * `DecimalText(locale)` (F5) as a codec: decodes with `parseDecimalText` (either separator) and
 * encodes with the locale's separator ("1234,5" in cs, "1234.5" in en), no grouping.
 */
export const DecimalText = (
  locale: Locale,
  scale: number,
): Schema.Codec<BigDecimal.BigDecimal, string> =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.BigDecimal,
      SchemaTransformation.transformEffect<BigDecimal.BigDecimal, string>({
        decode: (text, options) =>
          Result.match(parseDecimalText(text, scale), {
            onSuccess: (value) => Effect.succeed(value),
            onFailure: (code) => Effect.fail(decimalIssue(code, text, options)),
          }),
        encode: (value) => {
          const plain = BigDecimal.format(BigDecimal.normalize(value));
          return Effect.succeed(locale === "cs" ? plain.replace(".", ",") : plain);
        },
      }),
    ),
  );
