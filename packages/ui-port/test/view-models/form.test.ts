import { describe, expect, test } from "bun:test";
import { Invalid, type Locale } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as StandardSchema from "effect/StandardSchema";
import * as Str from "effect/String";

import { toUiError } from "../../src/api";
import {
  DecimalText,
  type FieldIssue,
  Form,
  type FormContext,
  FormSpec,
  mapServerIssues,
  parseDecimalText,
} from "../../src/view-models";

interface Draft {
  readonly name: string;
  readonly lines: ReadonlyArray<{ readonly qty: string }>;
}
interface Input {
  readonly name: string;
  readonly lines: ReadonlyArray<{ readonly qty: BigDecimal.BigDecimal }>;
}
type Ctx = FormContext & { readonly maxLines: number };

const schema = (locale: Locale): Schema.Codec<Input, Draft> =>
  Schema.Struct({
    name: Schema.String.check(
      Schema.makeFilter((s: string) => Str.trim(s) !== "", { message: "form.required" }),
    ),
    lines: Schema.Array(Schema.Struct({ qty: DecimalText(locale, 4) })),
  });

const spec: FormSpec<Draft, Input, Ctx> = FormSpec.make({
  schema,
  refine: (input, context) =>
    input.lines.length > context.maxLines
      ? [{ path: "lines", code: "document.lines_required" }]
      : [],
});
const validationIssues = (result: StandardSchema.StandardSchemaV1.Result<unknown>) => {
  if (result.issues === undefined) throw new Error("expected validation failure");
  return result.issues;
};

const issueRows = (result: StandardSchema.StandardSchemaV1.Result<unknown>) =>
  Arr.map(validationIssues(result), ({ path, message }) => [
    path === undefined ? undefined : Arr.join(Arr.map(path, String), "."),
    message,
  ]);

const ctx: Ctx = { locale: "cs", maxLines: 2 };
const empty: Draft = { name: "", lines: [{ qty: "1" }] };

describe("Form", () => {
  test("errors stay hidden while typing the first value, show on blur (F2)", () => {
    let f = Form.init<Draft>(empty);
    f = Form.check(f, spec, ctx);
    expect(f.clientIssues).toHaveLength(1);
    expect(Form.issuesAt(f, "name")).toEqual([]);
    expect(Form.issuesAt(f, "name", { showUntouched: true })).toHaveLength(1);
    f = Form.blur(f, "name", spec, ctx);
    expect(Arr.map(Form.issuesAt(f, "name"), (i) => i.code)).toEqual(["form.required"]);
  });

  test("failed submit marks everything visible; success returns the input (F3)", () => {
    const f = Form.change(Form.init<Draft>(empty), "lines.0.qty", "1,5x");
    const failed = Form.validate(f, spec, ctx);
    if (Result.isSuccess(failed)) throw new Error("expected failure");
    expect(Arr.map(Form.issuesAt(failed.failure, "lines"), (i) => i.path)).toEqual(["lines.0.qty"]);
    expect(Form.firstErrorPath(failed.failure, ["name", "lines"])).toEqual(Option.some("name"));
    const ok = Form.validate(
      Form.change(Form.change(f, "name", "Acme"), "lines.0.qty", "1 234,5"),
      spec,
      ctx,
    );
    expect(Result.map(ok, (i) => Arr.map(i.lines, (l) => BigDecimal.format(l.qty)))).toEqual(
      Result.succeed(["1234.5"]),
    );
  });

  test("refine runs after decode", () => {
    const f = Form.init<Draft>({ name: "x", lines: [{ qty: "1" }, { qty: "1" }, { qty: "1" }] });
    const failed = Form.validate(f, spec, ctx).pipe(Result.isFailure);
    expect(failed).toBe(true);
  });

  test("server issues clear per path on change; submit state transitions", () => {
    let f = Form.submitting(
      Form.init<Draft, string>({ name: "a", lines: [{ qty: "1" }] }, 3),
      "rk-1",
    );
    expect(f.submit).toEqual({ _tag: "Submitting", requestKey: Option.some("rk-1") });
    f = Form.applyServer(f, [
      { path: "lines.0.qty", code: "document.lines_required" },
      { path: "name", code: "ico.checksum" },
    ]);
    f = Form.change(f, "lines.0", { qty: "2" });
    expect(Arr.map(f.serverIssues, (i) => i.path)).toEqual(["name"]);
    expect(f.draft.lines[0]?.qty).toBe("2");
    f = Form.failed(Form.submitting(f), "offline");
    expect(f.submit._tag).toBe("Failed");
    f = Form.saved(f, 4);
    expect(f.baseRevision).toEqual(Option.some(4));
    expect(f.submit).toEqual({ _tag: "Idle" });
  });
});

describe("Form: review round 1 regressions", () => {
  test("editing a draft after a failed submit drops the Idempotency-Key; an unchanged retry keeps it", () => {
    const sent = Form.submitting(Form.init<Draft, string>({ name: "a", lines: [] }), "rk-1");
    const failed = Form.failed(sent, "offline");
    expect(failed.submit).toMatchObject({ _tag: "Failed", requestKey: Option.some("rk-1") });
    // unchanged retry: same value set again, key kept
    const same = Form.change(failed, "name", "a");
    expect(same.submit).toMatchObject({ requestKey: Option.some("rk-1") });
    // a real edit: the next submit is a new intent
    const edited = Form.change(failed, "name", "b");
    expect(edited.submit).toMatchObject({ _tag: "Failed", requestKey: Option.none() });
    // an edit while the request is in flight also keeps the old key off the retry
    const midFlight = Form.failed(Form.change(sent, "name", "c"), "offline");
    expect(midFlight.submit).toMatchObject({ _tag: "Failed", requestKey: Option.none() });
  });

  test("applyServer takes the decoded HTTP 422 Invalid directly", () => {
    const body = {
      _tag: "Invalid",
      issues: [
        { path: ["lines", 2, "unitPrice"], code: "document.lines_required" },
        { path: ["dueOn"], code: "document.due_before_issue", params: { issuedOn: "2026-11-01" } },
      ],
    };
    const error = Schema.decodeUnknownEffect(Invalid)(body).pipe(Effect.runSync, toUiError);
    const base = Form.init<Draft>({ name: "a", lines: [] });
    if (error._tag !== "Invalid") throw new Error("expected Invalid");
    const expected = [
      { path: "lines.2.unitPrice", code: "document.lines_required" },
      { path: "dueOn", code: "document.due_before_issue", params: { issuedOn: "2026-11-01" } },
    ];
    expect(Form.applyServer(base, error).serverIssues).toEqual(expected);
    expect(Form.applyServer(base, error.issues).serverIssues).toEqual(expected);
    // a Better Auth issue the AuthClient port reports keeps its auth.* code
    const auth = toUiError({
      _tag: "Invalid",
      issues: [{ path: [], code: "auth.bot_proof_required" }],
    });
    if (auth._tag !== "Invalid") throw new Error("expected Invalid");
    expect(auth.issues[0]?.code === "auth.bot_proof_required").toBe(true);
    expect(Form.applyServer(base, auth).serverIssues).toEqual([
      { path: "", code: "auth.bot_proof_required" },
    ]);
  });

  test("schema and Standard Schema V1 validator come from the same locale-aware schema", () => {
    const draft: Draft = { name: "", lines: [{ qty: "1,5x" }] };
    const result = spec.standard("cs")["~standard"].validate(draft);
    if (result instanceof Promise) throw new Error("expected sync validation");
    expect(issueRows(result)).toEqual([
      ["name", "form.required"],
      ["lines.0.qty", "form.decimal_invalid"],
    ]);
    const ok = spec
      .standard("en")
      ["~standard"].validate({ name: "x", lines: [{ qty: "1 234,5" }] });
    if (ok instanceof Promise || ok.issues !== undefined) throw new Error("expected success");
    (ok.value.lines[0]?.qty ?? BigDecimal.fromBigInt(0n))
      .pipe(BigDecimal.format, expect)
      .toBe("1234.5");
    // encoding back to draft text uses the locale's separator
    const input: Input = { name: "x", lines: [{ qty: BigDecimal.fromStringUnsafe("1.5") }] };
    expect(Effect.runSync(Schema.encodeEffect(spec.schema("cs"))(input)).lines[0]?.qty).toBe("1,5");
    expect(Effect.runSync(Schema.encodeEffect(spec.schema("en"))(input)).lines[0]?.qty).toBe("1.5");
    // a missing key is form.required
    const missing = spec.standard("cs")["~standard"].validate({ lines: [] });
    if (missing instanceof Promise) throw new Error("expected sync validation");
    expect(Arr.map(validationIssues(missing), (issue) => issue.message)).toEqual(["form.required"]);
  });
});

describe("mapServerIssues (F4)", () => {
  test("exact path, then longest shown prefix, else summary", () => {
    const issues: ReadonlyArray<FieldIssue> = [
      { path: "lines.2.unitPrice", code: "a" },
      { path: "lines.2.vat", code: "b" },
      { path: "contact", code: "c" },
    ];
    const { byField, summary } = mapServerIssues(issues, ["lines", "lines.2", "lines.2.unitPrice"]);
    expect(Arr.map(byField.get("lines.2.unitPrice") ?? [], (issue) => issue.code)).toEqual(["a"]);
    expect(Arr.map(byField.get("lines.2") ?? [], (issue) => issue.code)).toEqual(["b"]);
    expect(byField.has("lines")).toBe(false);
    expect(Arr.map(summary, (i) => i.code)).toEqual(["c"]);
  });
});

describe("parseDecimalText (F5)", () => {
  const ok = (t: string, scale = 2) => Result.map(parseDecimalText(t, scale), BigDecimal.format);
  test("comma or dot, space / NBSP group separators", () => {
    expect(ok("1 234,5")).toEqual(Result.succeed("1234.5"));
    expect(ok("1 234.50")).toEqual(Result.succeed("1234.5"));
    expect(ok("-0,125", 3)).toEqual(Result.succeed("-0.125"));
  });
  test("rejects junk, two separators, and too many decimals", () => {
    expect(parseDecimalText("1,2,3", 2)).toEqual(Result.fail("form.decimal_invalid"));
    expect(parseDecimalText("1.234,5", 2)).toEqual(Result.fail("form.decimal_invalid"));
    expect(parseDecimalText("1,005", 2)).toEqual(Result.fail("form.decimal_invalid"));
    expect(parseDecimalText("abc", 2)).toEqual(Result.fail("form.decimal_invalid"));
    expect(parseDecimalText("  ", 2)).toEqual(Result.fail("form.required"));
  });
});

describe("Form: review round 2 regressions", () => {
  test("replacing a field with a structurally equal value keeps the Idempotency-Key", () => {
    const failed = Form.failed(
      Form.submitting(Form.init<Draft, string>({ name: "a", lines: [{ qty: "1" }] }), "rk-1"),
      "offline",
    );
    // a fresh array with the same lines is the same intent
    const same = Form.change(failed, "lines", [{ qty: "1" }]);
    expect(same.submit).toMatchObject({ _tag: "Failed", requestKey: Option.some("rk-1") });
    // nested plain data, BigDecimal included, compares by value
    const withAmount = Form.failed(
      Form.submitting(
        Form.init<{ readonly amount: { readonly value: BigDecimal.BigDecimal } }, string>({
          amount: { value: BigDecimal.fromStringUnsafe("1.5") },
        }),
        "rk-2",
      ),
      "offline",
    );
    expect(
      Form.change(withAmount, "amount", { value: BigDecimal.fromStringUnsafe("1.5") }).submit,
    ).toMatchObject({ requestKey: Option.some("rk-2") });
    // a different nested value is a new intent
    const edited = Form.change(failed, "lines", [{ qty: "2" }]);
    expect(edited.submit).toMatchObject({ _tag: "Failed", requestKey: Option.none() });
    expect(edited.draft.lines).toEqual([{ qty: "2" }]);
  });

  test("an unannotated filter and an invalid literal report form.invalid, annotated codes stay", () => {
    const expectInvalidName = <CandidateDraft, CandidateInput>(
      candidate: Schema.Codec<CandidateInput, CandidateDraft>,
      initial: CandidateDraft,
      invalidName: string,
    ) => {
      const literalSpec = FormSpec.make({ schema: () => candidate });
      const form = Form.change(Form.init(initial), "name", invalidName);
      const standard = literalSpec.standard("cs")["~standard"].validate(form.draft);
      if (standard instanceof Promise) throw new Error("expected sync validation");
      expect(issueRows(standard)).toEqual([["name", "form.invalid"]]);
      const validated = Form.validate(form, literalSpec, { locale: "cs" });
      expect(Result.isFailure(validated) && validated.failure.clientIssues).toEqual([
        { path: "name", code: "form.invalid" },
      ]);
    };
    expectInvalidName(
      Schema.Struct({ name: Schema.String.check(Schema.makeFilter((value) => value.length > 0)) }),
      { name: "valid" },
      "",
    );
    expectInvalidName(
      Schema.Struct({ name: Schema.Literals(["red", "blue"]) }),
      { name: "red" },
      "green",
    );
    // annotated codes and their paths pass through unchanged
    expect(Form.validate(Form.init(empty), spec, ctx)).toMatchObject({
      failure: { clientIssues: [{ path: "name", code: "form.required" }] },
    });
  });
});
