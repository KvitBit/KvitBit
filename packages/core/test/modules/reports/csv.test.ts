import { describe, expect, test } from "bun:test";
import type { IsoDate } from "@kvitbit/domain/contract";
import { Effect, Stream } from "effect";
import {
  BOM,
  csvStream,
  encodeCsv,
  formatDecimal,
  ReportCompute,
  reportTable,
} from "../../../src/modules/reports";
import { int, money, num, text } from "../../../src/modules/reports/csv";
import { bucket, contactId, d, document } from "./fixtures";

describe("formatDecimal", () => {
  test.each([
    ["1234.5", ",", 2, "1234,50"],
    ["1234.5", ".", 2, "1234.50"],
    ["-0.005", ",", 2, "-0,01"], // half away from zero
    ["0.004", ".", 2, "0.00"],
    ["100", ",", 2, "100,00"],
    ["1e3", ".", undefined, "1000"],
    ["21", ",", undefined, "21"],
    ["25.125", ",", undefined, "25,125"],
    ["-7.50", ".", undefined, "-7.5"],
    ["0.05", ",", undefined, "0,05"],
  ] as const)("%s %s %s -> %s", (value, sep, scale, expected) => {
    expect(formatDecimal(d(value), sep, scale)).toBe(expected);
  });
});

describe("encodeCsv", () => {
  const table = {
    header: ["name", "amount", "count"],
    rows: [
      [text('Firma "Alfa"; s.r.o.'), money(d("1234.5")), int(3)],
      [text("line\nbreak"), money(d("-2")), int(0)],
      [text("a,b"), money(d("0")), int(1)],
      [text(null), num(d("12")), int(2)],
      [text('=HYPERLINK("x")'), money(d("-1.5")), int(4)],
    ],
  };

  test("cs: semicolons, decimal comma, RFC 4180 quoting, CRLF, BOM", () => {
    expect(encodeCsv(table, "cs")).toBe(
      `${BOM}name;amount;count\r\n` +
        `"Firma ""Alfa""; s.r.o.";1234,50;3\r\n` +
        `"line\nbreak";-2,00;0\r\n` +
        `a,b;0,00;1\r\n` +
        `;12;2\r\n` +
        `"'=HYPERLINK(""x"")";-1,50;4\r\n`,
    );
  });

  test("en: commas and decimal point; a comma in text is quoted", () => {
    expect(encodeCsv(table, "en")).toBe(
      `${BOM}name,amount,count\r\n` +
        `"Firma ""Alfa""; s.r.o.",1234.50,3\r\n` +
        `"line\nbreak",-2.00,0\r\n` +
        `"a,b",0.00,1\r\n` +
        `,12,2\r\n` +
        `"'=HYPERLINK(""x"")",-1.50,4\r\n`,
    );
  });

  test("formula-like text is neutralized; negative numbers are not", () => {
    for (const lead of ["=", "+", "-", "@", "\t"]) {
      expect(encodeCsv({ header: ["x"], rows: [[text(`${lead}1`)]] }, "en")).toBe(
        `${BOM}x\r\n${lead === "\t" ? "'\t1" : `'${lead}1`}\r\n`,
      );
    }
  });

  test("the stream carries the same bytes, one chunk per record", async () => {
    const chunks = await Effect.runPromise(Stream.runCollect(csvStream(table, "cs")));
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    expect(chunks.length).toBe(6);
    expect(chunks.map((c) => decoder.decode(c)).join("")).toBe(encodeCsv(table, "cs"));
    // UTF-8 BOM bytes first
    expect([...(chunks[0] ?? new Uint8Array()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("report tables", () => {
  const nov = { from: "2026-11-01" as IsoDate, to: "2026-11-30" as IsoDate };

  test("deterministic: the same rows in any input order give identical CSV", () => {
    const docs = [
      document(1, { contact: { id: contactId(2), name: "Beta; a.s." } }),
      document(2, { buckets: [bucket("reduced", "12", "99.99", "12")] }),
      document(3, { issuedOn: "2026-11-20" as IsoDate }),
    ];
    const a = encodeCsv(reportTable(ReportCompute.revenue(docs, nov, "contact")), "cs");
    const b = encodeCsv(
      reportTable(ReportCompute.revenue([...docs].reverse(), nov, "contact")),
      "cs",
    );
    expect(a).toBe(b);
    expect(a).toBe(
      `${BOM}group;label;count;net_czk;vat_czk;gross_czk\r\n` +
        `${contactId(1)};Odběratel s.r.o.;2;1099,99;222,00;1321,99\r\n` +
        `${contactId(2)};"Beta; a.s.";1;1000,00;210,00;1210,00\r\n`,
    );
  });

  test("vat summary rows: output then input, rate as its own digits", () => {
    const view = ReportCompute.vatSummary(
      [document(1, { buckets: [bucket("standard", "21", "1000", "210")] })],
      [],
      nov,
    );
    expect(encodeCsv(reportTable(view), "en")).toBe(
      `${BOM}section,month,treatment,rate_percent,base_czk,vat_czk,documents\r\n` +
        `output,2026-11,standard,21,1000.00,210.00,1\r\n`,
    );
  });
});
