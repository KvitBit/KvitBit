/**
 * Generic form state, ui-port-contracts 2.7. Forms keep the raw text the user typed and decode
 * it to the core input on blur and submit. Client issues come from decoding, server issues from
 * the last `Invalid`; both use the same codes (F1) and render as `issue.<code>`.
 *
 * The submit error type is a parameter so this module does not depend on the api area's
 * `UiError`; screens instantiate it with `UiError`.
 */

import type { Locale } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import type * as StandardSchema from "effect/StandardSchema";
import * as Str from "effect/String";

import { isMessageKey } from "../i18n";

const DECIMAL_TEXT = /^-?\d+(?:[.,]\d+)?$/;
const DECIMAL_SEPARATOR = /[.,]/;

/** Core paths joined with ".", e.g. "lines.2.unitPrice". */
export type FieldPath = string;

export interface FieldIssue {
  readonly path: FieldPath;
  /** A core `IssueCode` or a ui-only `form.*` code; the catalog key is `issue.<code>`. */
  readonly code: string;
  readonly params?: Readonly<Record<string, string>>;
}

type SubmitState<E> =
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
  const annotations = "annotations" in issue ? issue.annotations : issue.ast.annotations;
  const message: unknown =
    annotations?.[issue._tag === "MissingKey" ? "messageMissingKey" : "message"];
  if (Predicate.isString(message)) return message;
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
  Arr.join(
    Arr.map(path ?? [], (segment) => String(Predicate.isObject(segment) ? segment.key : segment)),
    ".",
  );

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
      });
      const normalize = (
        result: StandardSchema.StandardSchemaV1.Result<Input>,
      ): StandardSchema.StandardSchemaV1.Result<Input> =>
        result.issues === undefined
          ? result
          : {
              issues: Arr.map(result.issues, (issue) => ({
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
    // biome-ignore lint/plugin/no-throw-in-effect-modules: Async validation violates the synchronous FormSpec contract.
    if (result instanceof Promise) throw new Error("FormSpec schemas must decode synchronously");
    if (result.issues === undefined) return Result.succeed(result.value);
    return Result.fail(
      Arr.map(result.issues, (issue) => ({ path: toFieldPath(issue.path), code: issue.message })),
    );
  },
};

/** A server issue as decoded (`Invalid.issues`): the path is a segment list. */
interface ServerIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly code: string;
  readonly params?: Readonly<Record<string, string>> | undefined;
}

/** Joins a server issue's path with "." and keeps its code and params. */
const fromServerIssue = (issue: ServerIssue): FieldIssue =>
  issue.params === undefined
    ? { path: Arr.join(Arr.map(issue.path, String), "."), code: issue.code }
    : { path: Arr.join(Arr.map(issue.path, String), "."), code: issue.code, params: issue.params };

const isFieldIssue = (issue: ServerIssue | FieldIssue): issue is FieldIssue =>
  Predicate.isString(issue.path);

/** `path` equals `prefix` or lies below it ("lines.2.vat" is under "lines.2"). */
const isUnder: {
  (prefix: FieldPath): (path: FieldPath) => boolean;
  (path: FieldPath, prefix: FieldPath): boolean;
} = Fn.dual(
  2,
  (path: FieldPath, prefix: FieldPath): boolean =>
    path === prefix || Fn.pipe(path, Str.startsWith(`${prefix}.`)),
);

// biome-ignore lint/plugin/no-unknown-parameters: Widget paths can traverse and replace values before draft validation.
const setAt = (value: unknown, keys: ReadonlyArray<string>, next: unknown): unknown => {
  const [head, ...tail] = keys;
  if (head === undefined) return next;
  if (Arr.isArray(value)) {
    const index = Number(head);
    const copy = [...value];
    copy[index] = setAt(copy[index], tail, next);
    return copy;
  }
  const record = Predicate.isObjectOrArray(value) ? value : {};
  const field: unknown = Reflect.get(record, head);
  return { ...record, [head]: setAt(field, tail, next) };
};

/** Reads a value at a dotted path, undefined when absent. */
// biome-ignore lint/plugin/no-unknown-parameters: Raw drafts can contain any value at a widget path.
const getAt = (value: unknown, path: FieldPath): unknown =>
  path === ""
    ? value
    : Arr.reduce(Str.split(path, "."), value, (acc, key) => {
        const field: unknown = Predicate.isObjectOrArray(acc) ? Reflect.get(acc, key) : undefined;
        return field;
      });

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
  // biome-ignore lint/plugin/no-unknown-parameters: Widget values are validated by the form's Schema after editing.
  change: <D, E>(form: Form<D, E>, path: FieldPath, value: unknown): Form<D, E> => {
    const edited = !Equal.equals(getAt(form.draft, path), value);
    const draft = edited
      ? // biome-ignore lint/nursery/noUnsafeTypeAssertion: The form uses a dynamic widget path and validates the edited draft on decode.
        (setAt(form.draft, path === "" ? [] : Str.split(path, "."), value) as D)
      : form.draft;
    return {
      ...form,
      draft,
      serverIssues: Arr.filter(form.serverIssues, (i) => !isUnder(i.path, path)),
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
      touched: dedupe([...form.touched, ...Arr.map(issues, (i) => i.path)]),
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
    serverIssues: Arr.map("issues" in invalid ? invalid.issues : invalid, (issue) =>
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
      opts?.showUntouched === true ||
      form.submitted ||
      Arr.some(form.touched, (t) => isUnder(t, path));
    return visible
      ? Arr.filter([...form.clientIssues, ...form.serverIssues], (i) => isUnder(i.path, path))
      : [];
  },
  /** First issue path in `fieldOrder` to focus after a failed submit (F3). */
  firstErrorPath: <D, E>(
    form: Form<D, E>,
    fieldOrder: ReadonlyArray<FieldPath>,
  ): Option.Option<FieldPath> => {
    const all = [...form.clientIssues, ...form.serverIssues];
    return Option.fromNullishOr(
      Option.getOrUndefined(
        Arr.findFirst(fieldOrder, (field) => Arr.some(all, (i) => isUnder(i.path, field))),
      ) ?? all[0]?.path,
    );
  },
};

/**
 * Maps server issues onto the fields a screen shows (F4): exact path, else the longest shown
 * prefix ("lines.2" for "lines.2.vat" when the VAT control is hidden), else the form summary.
 */
export const mapServerIssues: {
  (
    shownFields: ReadonlyArray<FieldPath>,
  ): (issues: ReadonlyArray<FieldIssue>) => {
    readonly byField: ReadonlyMap<FieldPath, ReadonlyArray<FieldIssue>>;
    readonly summary: ReadonlyArray<FieldIssue>;
  };
  (
    issues: ReadonlyArray<FieldIssue>,
    shownFields: ReadonlyArray<FieldPath>,
  ): {
    readonly byField: ReadonlyMap<FieldPath, ReadonlyArray<FieldIssue>>;
    readonly summary: ReadonlyArray<FieldIssue>;
  };
} = Fn.dual(
  2,
  (
    issues: ReadonlyArray<FieldIssue>,
    shownFields: ReadonlyArray<FieldPath>,
  ): {
    readonly byField: ReadonlyMap<FieldPath, ReadonlyArray<FieldIssue>>;
    readonly summary: ReadonlyArray<FieldIssue>;
  } => {
    const byField = new Map<FieldPath, Array<FieldIssue>>();
    const summary: Array<FieldIssue> = [];
    for (const issue of issues) {
      const target = Arr.reduce<FieldPath, FieldPath | undefined>(
        Arr.filter(shownFields, (f) => isUnder(issue.path, f)),
        undefined,
        (best, f) => (best === undefined || f.length > best.length ? f : best),
      );
      if (target === undefined) summary.push(issue);
      else byField.set(target, [...(byField.get(target) ?? []), issue]);
    }
    return { byField, summary };
  },
);

/**
 * `DecimalText` (F5): accepts "," or "." as the decimal separator and spaces / NBSP / narrow
 * NBSP as group separators, at most `scale` decimals. Fails with `form.decimal_invalid`.
 */
export const parseDecimalText: {
  (
    scale: number,
  ): (
    text: string,
  ) => Result.Result<BigDecimal.BigDecimal, "form.decimal_invalid" | "form.required">;
  (
    text: string,
    scale: number,
  ): Result.Result<BigDecimal.BigDecimal, "form.decimal_invalid" | "form.required">;
} = Fn.dual(
  2,
  (
    text: string,
    scale: number,
  ): Result.Result<BigDecimal.BigDecimal, "form.decimal_invalid" | "form.required"> => {
    const compact = Fn.pipe(text, Str.replace(/[\s  ]/g, ""));
    if (compact === "") return Result.fail("form.required");
    if (!DECIMAL_TEXT.test(compact)) return Result.fail("form.decimal_invalid");
    const [, fraction = ""] = Str.split(compact, DECIMAL_SEPARATOR);
    if (fraction.length > scale) return Result.fail("form.decimal_invalid");
    return Option.match(BigDecimal.fromString(Fn.pipe(compact, Str.replace(",", "."))), {
      onNone: () => Result.fail("form.decimal_invalid" as const),
      onSome: (value) => value.pipe(BigDecimal.normalize, Result.succeed),
    });
  },
);

const decimalIssue = (
  code: "form.decimal_invalid" | "form.required",
  input: string,
  options: SchemaAST.ParseOptions,
) => new SchemaIssue.InvalidValue({ message: code }, input, options);

/**
 * `DecimalText(locale)` (F5) as a codec: decodes with `parseDecimalText` (either separator) and
 * encodes with the locale's separator ("1234,5" in cs, "1234.5" in en), no grouping.
 */
export const DecimalText: {
  (scale: number): (locale: Locale) => Schema.Codec<BigDecimal.BigDecimal, string>;
  (locale: Locale, scale: number): Schema.Codec<BigDecimal.BigDecimal, string>;
} = Fn.dual(
  2,
  (locale: Locale, scale: number): Schema.Codec<BigDecimal.BigDecimal, string> =>
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
            const plain = value.pipe(BigDecimal.normalize, BigDecimal.format);
            return Effect.succeed(locale === "cs" ? Fn.pipe(plain, Str.replace(".", ",")) : plain);
          },
        }),
      ),
    ),
);
