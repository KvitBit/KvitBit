/**
 * HTML to PDF. `PdfEngine` is the seam; `ChromiumPdfEngine` prints with headless Chromium via
 * playwright-core (loaded lazily, so composition roots that never render PDFs don't load it), and
 * `FakePdfEngine` returns a fixed one-page PDF for tests.
 */
import { Config, Context, Data, Effect, Layer, Option } from "effect";
import type { Browser } from "playwright-core";

export class PdfEngineError extends Data.TaggedError("PdfEngineError")<{
  readonly stage: "launch" | "render";
  readonly cause: unknown;
}> {}

export class PdfEngine extends Context.Service<
  PdfEngine,
  {
    /** Prints a self-contained HTML page to A4 PDF bytes, honouring its `@page` rules. */
    readonly htmlToPdf: (html: string) => Effect.Effect<Uint8Array, PdfEngineError>;
  }
>()("kvitbit/adapters/PdfEngine") {}

export interface ChromiumOptions {
  /** Chromium or Chrome binary. Omitted uses playwright's own browser cache. */
  readonly executablePath?: string;
  /** Per-render timeout. Default 30 s. */
  readonly timeoutMs?: number;
}

/**
 * Launches one headless browser for the scope's lifetime; each render gets a fresh context
 * with JavaScript disabled and every network request blocked (templates are self-contained).
 */
export const makeChromiumPdfEngine = (options: ChromiumOptions = {}) =>
  Effect.gen(function* () {
    const timeout = options.timeoutMs ?? 30_000;
    const browser: Browser = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const { chromium } = await import("playwright-core");
          return chromium.launch({
            headless: true,
            ...(options.executablePath === undefined
              ? {}
              : { executablePath: options.executablePath }),
          });
        },
        catch: (cause) => new PdfEngineError({ stage: "launch", cause }),
      }),
      (b) => Effect.promise(() => b.close()).pipe(Effect.ignore),
    );

    const htmlToPdf = (html: string) =>
      Effect.tryPromise({
        try: async () => {
          const context = await browser.newContext({ javaScriptEnabled: false });
          try {
            const page = await context.newPage();
            await page.route("**/*", (route) =>
              route.request().url().startsWith("data:") ? route.continue() : route.abort(),
            );
            await page.setContent(html, { waitUntil: "load", timeout });
            const pdf = await page.pdf({
              format: "A4",
              printBackground: true,
              preferCSSPageSize: true,
            });
            return new Uint8Array(pdf);
          } finally {
            await context.close();
          }
        },
        catch: (cause) => new PdfEngineError({ stage: "render", cause }),
      });

    return PdfEngine.of({ htmlToPdf });
  });

/** `CHROMIUM_PATH` (optional) selects the browser binary. */
export const ChromiumPdfEngine = Layer.effect(
  PdfEngine,
  Effect.gen(function* () {
    const path = yield* Config.option(Config.String("CHROMIUM_PATH"));
    return yield* makeChromiumPdfEngine(Option.isSome(path) ? { executablePath: path.value } : {});
  }),
);

/** A minimal valid one-page A4 PDF with a correct cross-reference table. */
const fakePdf = (): Uint8Array => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << >> >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
};

/** Test engine: records every HTML it is given and returns the same one-page PDF. */
export const makeFakePdfEngine = () => {
  const rendered: Array<string> = [];
  const service = PdfEngine.of({
    htmlToPdf: (html) =>
      Effect.sync(() => {
        rendered.push(html);
        return fakePdf();
      }),
  });
  return { service, rendered: rendered as ReadonlyArray<string> };
};

export const FakePdfEngine = Layer.sync(PdfEngine, () => makeFakePdfEngine().service);
