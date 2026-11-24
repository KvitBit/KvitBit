import { describe, expect, test } from "bun:test";
import { CompanyRegistry, type RegistryRecord, RegistryUnavailable } from "@kvitbit/domain/ports";
import { Effect, Layer } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { AresV3 } from "../../src/registry";
import notFound from "./fixtures/ares-not-found.json";
import serverError from "./fixtures/ares-server-error.json";
import soleTrader from "./fixtures/ares-sole-trader.json";
import sro from "./fixtures/ares-sro.json";
import terminated from "./fixtures/ares-terminated.json";

type Reply = Effect.Effect<Response, HttpClientError.HttpClientError>;

interface Recorded {
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
  readonly signals: Array<AbortSignal>;
}

/** HttpClient that answers every request with `reply` and records the requests. */
const fakeHttp = (reply: (request: HttpClientRequest.HttpClientRequest) => Reply) => {
  const recorded: Recorded = { requests: [], signals: [] };
  const client = HttpClient.make((request, _url, signal) => {
    recorded.requests.push(request);
    recorded.signals.push(signal);
    return reply(request).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    );
  });
  return { recorded, layer: Layer.succeed(HttpClient.HttpClient, client) };
};

const json = (body: unknown, status = 200) => Effect.succeed(Response.json(body, { status }));

const lookup = (
  ico: string,
  reply: (request: HttpClientRequest.HttpClientRequest) => Reply,
  config: AresV3.AresV3Config = {},
) => {
  const http = fakeHttp(reply);
  const run = Effect.gen(function* () {
    const registry = yield* CompanyRegistry;
    return yield* registry.lookup(ico);
  }).pipe(
    Effect.provide(AresV3.layerHttp(config).pipe(Layer.provide(http.layer))),
    Effect.result,
    Effect.runPromise,
  );
  return run.then((result) => ({ result, ...http.recorded }));
};

const expectUnavailable = async (outcome: ReturnType<typeof lookup>) => {
  const { result } = await outcome;
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(RegistryUnavailable);
};

const expectRecord = async (outcome: ReturnType<typeof lookup>): Promise<RegistryRecord | null> => {
  const { result } = await outcome;
  if (result._tag === "Failure") throw new Error(`unexpected failure ${String(result.failure)}`);
  return result.success;
};

describe("AresV3 lookup", () => {
  test("GETs the pinned ARES v3 subject endpoint and asks for JSON", async () => {
    const { requests } = await lookup("10047514", () => json(sro));
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe(
      "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/10047514",
    );
    expect(request?.headers.accept).toBe("application/json");
  });

  test("maps a full s.r.o. record", async () => {
    const record = await expectRecord(lookup("10047514", () => json(sro)));
    expect(record).toEqual({
      name: "Testovací Obchod s.r.o.",
      address: {
        street: "Na Florenci 2116/15",
        city: "Praha",
        postalCode: "11000",
        country: "CZ",
      },
      dic: "CZ10047514",
      legalForm: "112",
      registerEntry: "C 123456/MSPH",
      terminatedOn: null,
    });
  });

  test("maps a sole trader without DIČ or register entry", async () => {
    const record = await expectRecord(lookup("10079190", () => json(soleTrader)));
    expect(record).toEqual({
      name: "Jana Ukázková",
      address: { street: "Masarykova 12", city: "Brno", postalCode: "60200", country: "CZ" },
      dic: null,
      legalForm: "101",
      registerEntry: null,
      terminatedOn: null,
    });
  });

  test("maps datumZaniku to terminatedOn", async () => {
    const record = await expectRecord(lookup("10087109", () => json(terminated)));
    expect<unknown>(record?.terminatedOn).toBe("2024-06-30");
    expect(record?.registerEntry).toBe("B 9876/KSOS");
  });

  test("404 means no record", async () => {
    expect(await expectRecord(lookup("10047514", () => json(notFound, 404)))).toBeNull();
  });

  test("a malformed IČO returns null without a request", async () => {
    for (const ico of ["1004751", "100475144", "1004751a", "../10047514", ""]) {
      const { result, requests } = await lookup(ico, () => json(sro));
      expect(result).toMatchObject({ _tag: "Success", success: null });
      expect(requests).toHaveLength(0);
    }
  });

  test("500 is RegistryUnavailable", async () => {
    await expectUnavailable(lookup("10047514", () => json(serverError, 500)));
  });

  test("other non-200 statuses (429, 503, 400) are RegistryUnavailable", async () => {
    for (const status of [429, 503, 400]) {
      await expectUnavailable(lookup("10047514", () => json(serverError, status)));
    }
  });

  test("a transport error is RegistryUnavailable", async () => {
    await expectUnavailable(
      lookup("10047514", (request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, cause: new Error("ECONNRESET") }),
          }),
        ),
      ),
    );
  });

  test("a hanging request times out as RegistryUnavailable", async () => {
    const started = Date.now();
    await expectUnavailable(lookup("10047514", () => Effect.never, { timeout: "30 millis" }));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a non-JSON body is RegistryUnavailable", async () => {
    await expectUnavailable(
      lookup("10047514", () =>
        Effect.succeed(new Response("<html>maintenance</html>", { status: 200 })),
      ),
    );
  });

  test("a body missing obchodniJmeno is RegistryUnavailable", async () => {
    const { obchodniJmeno: _, ...withoutName } = sro;
    await expectUnavailable(lookup("10047514", () => json(withoutName)));
  });

  test("an impossible datumZaniku is RegistryUnavailable", async () => {
    await expectUnavailable(
      lookup("10087109", () => json({ ...terminated, datumZaniku: "2024-02-30" })),
    );
  });

  test("a blank obchodniJmeno is RegistryUnavailable", async () => {
    await expectUnavailable(lookup("10047514", () => json({ ...sro, obchodniJmeno: "   " })));
  });

  test("a pravniForma that is not three digits is RegistryUnavailable", async () => {
    await expectUnavailable(lookup("10047514", () => json({ ...sro, pravniForma: "ABC" })));
  });

  test("a body that stalls after the headers times out as RegistryUnavailable", async () => {
    const stalled = () =>
      Effect.succeed(
        new Response(
          new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")) }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const started = Date.now();
    await expectUnavailable(lookup("10047514", stalled, { timeout: "30 millis" }));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("404 and 500 responses release the request when the lookup ends", async () => {
    const openBody = (status: number) => () =>
      Effect.succeed(new Response(new ReadableStream({}), { status }));
    for (const status of [404, 500]) {
      const { signals } = await lookup("10047514", openBody(status));
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    }
  });

  test("a subject for a different IČO is RegistryUnavailable", async () => {
    await expectUnavailable(lookup("10079190", () => json(sro)));
  });
});

describe("AresV3 address mapping", () => {
  const subject = (sidlo: Record<string, unknown>) => ({
    ico: "10047514",
    obchodniJmeno: "Firma s.r.o.",
    sidlo,
  });
  const address = (sidlo: Record<string, unknown>) =>
    expectRecord(lookup("10047514", () => json(subject(sidlo)))).then((r) => r?.address);

  test("orientation number letter is appended", async () => {
    expect(
      await address({
        nazevObce: "Plzeň",
        nazevUlice: "Americká",
        cisloDomovni: 1,
        cisloOrientacni: 3,
        cisloOrientacniPismeno: "a",
        psc: 30100,
      }),
    ).toEqual({ street: "Americká 1/3a", city: "Plzeň", postalCode: "30100", country: "CZ" });
  });

  test("a village without streets uses the municipality part", async () => {
    expect(
      await address({
        nazevObce: "Lhota",
        nazevCastiObce: "Horní Lhota",
        cisloDomovni: 42,
        psc: 7301,
      }),
    ).toEqual({ street: "Horní Lhota 42", city: "Lhota", postalCode: "07301", country: "CZ" });
  });

  test("a registration number (typCisloDomovni 2) is written as č. ev.", async () => {
    expect(
      await address({ nazevObce: "Lhota", cisloDomovni: 7, typCisloDomovni: 2, psc: 25001 }),
    ).toEqual({ street: "Lhota č. ev. 7", city: "Lhota", postalCode: "25001", country: "CZ" });
  });

  test("only textovaAdresa is parsed into street, postal code and city", async () => {
    expect(
      await address({ textovaAdresa: "Na Florenci 2116/15, Nové Město, 110 00 Praha 1" }),
    ).toEqual({
      street: "Na Florenci 2116/15",
      city: "Praha 1",
      postalCode: "11000",
      country: "CZ",
    });
  });

  test("an unparseable textovaAdresa becomes the street line", async () => {
    expect(await address({ kodStatu: "SK", textovaAdresa: "Hlavná 1 Bratislava" })).toEqual({
      street: "Hlavná 1 Bratislava",
      city: "",
      postalCode: "",
      country: "SK",
    });
  });

  test("a foreign address keeps kodStatu and pscTxt", async () => {
    expect(
      await address({
        kodStatu: "DE",
        nazevObce: "Berlin",
        nazevUlice: "Unter den Linden",
        cisloOrientacni: 77,
        pscTxt: "10117",
      }),
    ).toEqual({
      street: "Unter den Linden 77",
      city: "Berlin",
      postalCode: "10117",
      country: "DE",
    });
  });

  test("a street without a city keeps the structured street", async () => {
    expect(
      await address({
        nazevUlice: "Dlouhá",
        cisloDomovni: 5,
        textovaAdresa: "Dlouhá 5, 70200 Ostrava",
      }),
    ).toEqual({ street: "Dlouhá 5", city: "Ostrava", postalCode: "70200", country: "CZ" });
    expect(await address({ nazevUlice: "Dlouhá", cisloDomovni: 5 })).toEqual({
      street: "Dlouhá 5",
      city: "",
      postalCode: "",
      country: "CZ",
    });
  });

  test("a missing psc is filled from textovaAdresa", async () => {
    expect(
      await address({
        nazevObce: "Praha",
        nazevUlice: "Dlouhá",
        cisloDomovni: 5,
        textovaAdresa: "Dlouhá 5, Staré Město, 110 00 Praha",
      }),
    ).toEqual({ street: "Dlouhá 5", city: "Praha", postalCode: "11000", country: "CZ" });
  });

  test("without a structured house number the parsed street wins over the district", async () => {
    expect(
      await address({
        nazevObce: "Praha",
        nazevCastiObce: "Nové Město",
        psc: 11000,
        textovaAdresa: "Na Florenci 2116/15, Nové Město, 110 00 Praha 1",
      }),
    ).toEqual({ street: "Na Florenci 2116/15", city: "Praha", postalCode: "11000", country: "CZ" });
    expect(
      await address({
        nazevObce: "Praha",
        nazevUlice: "Na Florenci",
        textovaAdresa: "Na Florenci 2116/15, Nové Město, 110 00 Praha 1",
      }),
    ).toEqual({ street: "Na Florenci 2116/15", city: "Praha", postalCode: "11000", country: "CZ" });
  });

  test("a house number without any name takes the street from textovaAdresa", async () => {
    expect(await address({ cisloDomovni: 5, textovaAdresa: "Dlouhá 5, 110 00 Praha" })).toEqual({
      street: "Dlouhá 5",
      city: "Praha",
      postalCode: "11000",
      country: "CZ",
    });
    expect(await address({ cisloDomovni: 5 })).toEqual({
      street: "5",
      city: "",
      postalCode: "",
      country: "CZ",
    });
  });

  test("a street name alone, without number or text, is kept", async () => {
    expect(await address({ nazevObce: "Praha", nazevUlice: "Na Florenci", psc: 11000 })).toEqual({
      street: "Na Florenci",
      city: "Praha",
      postalCode: "11000",
      country: "CZ",
    });
  });

  test("a missing sidlo gives an empty Czech address", async () => {
    const record = await expectRecord(
      lookup("10047514", () => json({ ico: "10047514", obchodniJmeno: "Firma s.r.o." })),
    );
    expect(record).toEqual({
      name: "Firma s.r.o.",
      address: { street: "", city: "", postalCode: "", country: "CZ" },
      dic: null,
      legalForm: "",
      registerEntry: null,
      terminatedOn: null,
    });
  });
});

describe("AresV3 layers", () => {
  test("the live layer needs no further services", () => {
    const live: Layer.Layer<CompanyRegistry> = AresV3.layer;
    expect(Layer.isLayer(live)).toBe(true);
  });
});
