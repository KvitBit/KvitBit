import { describe, expect, test } from "bun:test";
import { BigDecimal, Option, Result } from "effect";
import {
  type FieldIssue,
  Form,
  type FormSpec,
  mapServerIssues,
  parseDecimalText,
} from "../../src/view-models";

interface Draft {
  readonly name: string;
  readonly lines: ReadonlyArray<{ readonly qty: string }>;
}
interface Input {
  readonly name: string;
  readonly qty: ReadonlyArray<BigDecimal.BigDecimal>;
}

const spec: FormSpec<Draft, Input, { readonly maxLines: number }> = {
  decode: (draft) => {
    const issues: Array<FieldIssue> = [];
    if (draft.name.trim() === "") issues.push({ path: "name", code: "form.required" });
    const qty = draft.lines.map((l, i) =>
      Result.match(parseDecimalText(l.qty, 4), {
        onSuccess: (v) => v,
        onFailure: (code) => {
          issues.push({ path: `lines.${i}.qty`, code });
          return BigDecimal.fromBigInt(0n);
        },
      }),
    );
    return issues.length > 0 ? Result.fail(issues) : Result.succeed({ name: draft.name, qty });
  },
  refine: (input, ctx) =>
    input.qty.length > ctx.maxLines ? [{ path: "lines", code: "document.lines_required" }] : [],
};
const ctx = { maxLines: 2 };
const empty: Draft = { name: "", lines: [{ qty: "1" }] };

describe("Form", () => {
  test("errors stay hidden while typing the first value, show on blur (F2)", () => {
    let f = Form.init<Draft>(empty);
    f = Form.check(f, spec, ctx);
    expect(f.clientIssues).toHaveLength(1);
    expect(Form.issuesAt(f, "name")).toEqual([]);
    expect(Form.issuesAt(f, "name", { showUntouched: true })).toHaveLength(1);
    f = Form.blur(f, "name", spec, ctx);
    expect(Form.issuesAt(f, "name").map((i) => i.code)).toEqual(["form.required"]);
  });

  test("failed submit marks everything visible; success returns the input (F3)", () => {
    const f = Form.change(Form.init<Draft>(empty), "lines.0.qty", "1,5x");
    const failed = Form.validate(f, spec, ctx);
    if (Result.isSuccess(failed)) throw new Error("expected failure");
    expect(Form.issuesAt(failed.failure, "lines").map((i) => i.path)).toEqual(["lines.0.qty"]);
    expect(Form.firstErrorPath(failed.failure, ["name", "lines"])).toEqual(Option.some("name"));
    const ok = Form.validate(
      Form.change(Form.change(f, "name", "Acme"), "lines.0.qty", "1 234,5"),
      spec,
      ctx,
    );
    expect(Result.map(ok, (i) => i.qty.map((q) => BigDecimal.format(q)))).toEqual(
      Result.succeed(["1234.5"]),
    );
  });

  test("refine runs after decode", () => {
    const f = Form.init<Draft>({ name: "x", lines: [{ qty: "1" }, { qty: "1" }, { qty: "1" }] });
    expect(Result.isFailure(Form.validate(f, spec, ctx))).toBe(true);
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
    expect(f.serverIssues.map((i) => i.path)).toEqual(["name"]);
    expect(f.draft.lines[0]?.qty).toBe("2");
    f = Form.failed(Form.submitting(f), "offline");
    expect(f.submit._tag).toBe("Failed");
    f = Form.saved(f, 4);
    expect(f.baseRevision).toEqual(Option.some(4));
    expect(f.submit).toEqual({ _tag: "Idle" });
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
    expect(byField.get("lines.2.unitPrice")?.map((i) => i.code)).toEqual(["a"]);
    expect(byField.get("lines.2")?.map((i) => i.code)).toEqual(["b"]);
    expect(byField.has("lines")).toBe(false);
    expect(summary.map((i) => i.code)).toEqual(["c"]);
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
