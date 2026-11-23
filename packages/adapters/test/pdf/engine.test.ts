import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Effect, Layer } from "effect";
import {
  ChromiumPdfEngine,
  FakePdfEngine,
  makeChromiumPdfEngine,
  makeFakePdfEngine,
  PdfEngine,
  renderDocumentHtml,
  renderDocumentPdf,
  renderReportPdf,
} from "../../src/pdf";
import { czkModel, eurModel, reportModel } from "./fixtures";

const startsWithPdf = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

describe("FakePdfEngine", () => {
  test("returns a valid one-page PDF and records the HTML it printed", async () => {
    const fake = makeFakePdfEngine();
    const bytes = await Effect.runPromise(
      renderDocumentPdf(czkModel(), "classic", "cs").pipe(
        Effect.provide(Layer.succeed(PdfEngine, fake.service)),
      ),
    );
    expect(startsWithPdf(bytes)).toBe(true);
    const pdf = new TextDecoder().decode(bytes);
    expect(pdf).toContain("/Count 1");
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)?.[1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    expect(fake.rendered).toEqual([renderDocumentHtml(czkModel(), "classic", "cs")]);
  });

  test("layer form serves reports too", async () => {
    const bytes = await Effect.runPromise(
      renderReportPdf(reportModel(), "en").pipe(Effect.provide(FakePdfEngine)),
    );
    expect(startsWithPdf(bytes)).toBe(true);
  });
});

/** CHROMIUM_PATH, then a system Chromium or Chrome, then playwright's browser cache. */
const findChromium = async (): Promise<string | null> => {
  const fromEnv = process.env.CHROMIUM_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const found = Bun.which(name);
    if (found) return found;
  }
  try {
    const { chromium } = await import("playwright-core");
    const cached = chromium.executablePath();
    return existsSync(cached) ? cached : null;
  } catch {
    return null;
  }
};

const chromiumPath = await findChromium();
if (chromiumPath === null) {
  process.stderr.write(
    "[pdf] Chromium smoke test skipped: no CHROMIUM_PATH, chromium, chromium-browser, google-chrome or playwright browser found\n",
  );
}

describe.skipIf(chromiumPath === null)("ChromiumPdfEngine (smoke)", () => {
  test("prints every template and the report to PDF bytes", async () => {
    const program = Effect.gen(function* () {
      const engine = yield* makeChromiumPdfEngine({ executablePath: chromiumPath ?? "" });
      const layer = Layer.succeed(PdfEngine, engine);
      const classic = yield* renderDocumentPdf(
        { ...czkModel(), status: "draft", number: null },
        "classic",
        "cs",
      ).pipe(Effect.provide(layer));
      const modern = yield* renderDocumentPdf(eurModel(), "modern_minimal", "en").pipe(
        Effect.provide(layer),
      );
      // The Config-driven layer reads CHROMIUM_PATH from the environment.
      process.env.CHROMIUM_PATH = chromiumPath ?? "";
      const report = yield* renderReportPdf(reportModel(), "cs").pipe(
        Effect.provide(ChromiumPdfEngine),
      );
      return [classic, modern, report];
    });
    const outputs = await Effect.runPromise(Effect.scoped(program));
    for (const bytes of outputs) {
      expect(startsWithPdf(bytes)).toBe(true);
      expect(bytes.length).toBeGreaterThan(1000);
    }
    // A4 portrait media box (595 x 842 pt).
    expect(new TextDecoder("latin1").decode(outputs[0])).toMatch(
      /\/MediaBox \[0 0 59\d\.\d+ 84\d\.\d+\]/,
    );
  }, 60_000);
});
