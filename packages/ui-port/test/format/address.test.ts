import { describe, expect, test } from "bun:test";
import {
  type AddressFields,
  applyAddressInputChange,
  applyAddressPaste,
  parseAddress,
} from "../../src/format";

const emptyCzech: AddressFields = {
  street: "",
  city: "",
  postalCode: "",
  country: "CZ",
};

describe("parseAddress", () => {
  test("parses Czech and Slovak single-line and multiline addresses", () => {
    expect(parseAddress("Jankovcova 1522/53, 170 00 Praha 7")).toEqual({
      street: "Jankovcova 1522/53",
      postalCode: "170 00",
      city: "Praha 7",
    });

    expect(parseAddress("Na Florenci 2116/15, Nové Město, 110 00 Praha 1")).toEqual({
      street: "Na Florenci 2116/15",
      postalCode: "110 00",
      city: "Praha 1",
    });

    expect(
      parseAddress("Na Florenci 2116/15, Nové Město, 110 00 Praha 1, Česká republika"),
    ).toEqual({
      street: "Na Florenci 2116/15",
      postalCode: "110 00",
      city: "Praha 1",
      country: "CZ",
    });

    expect(parseAddress("Jankovcova 1522/53\n170 00 Praha 7\nCzechia")).toEqual({
      street: "Jankovcova 1522/53",
      postalCode: "170 00",
      city: "Praha 7",
      country: "CZ",
    });

    expect(parseAddress("Na Příkopě 859/22, Praha 1, 110 00")).toEqual({
      street: "Na Příkopě 859/22",
      postalCode: "110 00",
      city: "Praha 1",
    });

    expect(parseAddress("Na Příkopě 859/22, 110 00, Praha 1")).toEqual({
      street: "Na Příkopě 859/22",
      postalCode: "110 00",
      city: "Praha 1",
    });

    expect(parseAddress("Jankovcova 1522/53 170 00 Praha 7")).toEqual({
      street: "Jankovcova 1522/53",
      postalCode: "170 00",
      city: "Praha 7",
    });

    expect(parseAddress("170 00 Praha 7")).toEqual({
      postalCode: "170 00",
      city: "Praha 7",
    });

    expect(parseAddress("Štefánikova 12, 811 05 Bratislava, Slovensko")).toEqual({
      street: "Štefánikova 12",
      postalCode: "811 05",
      city: "Bratislava",
      country: "SK",
    });

    expect(parseAddress("Adresa: Křižíkova 148/34, CZ-186 00 Praha 8")).toEqual({
      street: "Křižíkova 148/34",
      postalCode: "186 00",
      city: "Praha 8",
      country: "CZ",
    });

    expect(parseAddress("Jankovcova 1522/53, Praha 7")).toEqual({
      street: "Jankovcova 1522/53",
      city: "Praha 7",
    });
  });

  test("parses EU, UK, US, and Canadian addresses", () => {
    expect(parseAddress("Friedrichstraße 123, 10117 Berlin, Germany")).toEqual({
      street: "Friedrichstraße 123",
      postalCode: "10117",
      city: "Berlin",
      country: "DE",
    });

    expect(parseAddress("Stephansplatz 1, 1010 Wien, Österreich")).toEqual({
      street: "Stephansplatz 1",
      postalCode: "1010",
      city: "Wien",
      country: "AT",
    });

    expect(parseAddress("Stephansplatz 1, A-1010 Wien")).toEqual({
      street: "Stephansplatz 1",
      postalCode: "1010",
      city: "Wien",
      country: "AT",
    });

    expect(parseAddress("ul. Marszałkowska 1, 00-001 Warszawa, Polska")).toEqual({
      street: "ul. Marszałkowska 1",
      postalCode: "00-001",
      city: "Warszawa",
      country: "PL",
    });

    expect(parseAddress("Damrak 1, 1012 LG Amsterdam, Netherlands")).toEqual({
      street: "Damrak 1",
      postalCode: "1012 LG",
      city: "Amsterdam",
      country: "NL",
    });

    expect(parseAddress("221B Baker Street, London, NW1 6XE, United Kingdom")).toEqual({
      street: "221B Baker Street",
      postalCode: "NW1 6XE",
      city: "London",
      country: "GB",
    });

    expect(parseAddress("10 Downing Street, London SW1A 2AA, UK")).toEqual({
      street: "10 Downing Street",
      postalCode: "SW1A 2AA",
      city: "London",
      country: "GB",
    });

    expect(parseAddress("1600 Amphitheatre Parkway, Mountain View, CA 94043, USA")).toEqual({
      street: "1600 Amphitheatre Parkway",
      city: "Mountain View, CA",
      postalCode: "94043",
      country: "US",
    });

    expect(parseAddress("100 Queen St W, Toronto, ON M5H 2N2, Canada")).toEqual({
      street: "100 Queen St W",
      city: "Toronto, ON",
      postalCode: "M5H 2N2",
      country: "CA",
    });

    expect(parseAddress("Friedrichstraße 123, Berlin, Germany")).toEqual({
      street: "Friedrichstraße 123",
      city: "Berlin",
      country: "DE",
    });

    expect(parseAddress("123 Main St, Suite 400, 10117 Berlin")).toEqual({
      street: "123 Main St, Suite 400",
      postalCode: "10117",
      city: "Berlin",
    });
  });

  test("returns undefined for single-field values and non-address strings", () => {
    for (const raw of [
      "",
      "   ",
      "Praha",
      "Praha 7",
      "170 00",
      "Jankovcova 1522/53",
      "Václavské náměstí 846/1",
      "1600 Amphitheatre Parkway",
      "10001 Main Street",
      "123 Main St, Apt 4B",
      "Jankovcova 1522/53, 2. patro",
      "Novák Design, s.r.o.",
      "CZ65 0800 0000 1920 0014 5399",
      "27082440",
      "info@kvitbit.cz",
      "https://kvitbit.cz/onboarding",
      "C 12345/MSPH vedená u Městského soudu v Praze",
    ]) {
      expect(parseAddress(raw)).toBeUndefined();
    }
  });
});

describe("applyAddressPaste", () => {
  test("prefills all empty fields when pasting a full address into any address input", () => {
    for (const target of ["street", "city", "postalCode"] as const) {
      expect(
        applyAddressPaste(emptyCzech, target, "Jankovcova 1522/53, 170 00 Praha 7", {
          defaultCountry: "CZ",
        }),
      ).toEqual({
        street: "Jankovcova 1522/53",
        city: "Praha 7",
        postalCode: "170 00",
        country: "CZ",
      });
    }
  });

  test("preserves non-empty sibling fields while filling empty ones", () => {
    const existing: AddressFields = {
      street: "",
      city: "Brno",
      postalCode: "",
      country: "CZ",
    };
    expect(
      applyAddressPaste(existing, "street", "Jankovcova 1522/53, 170 00 Praha 7", {
        defaultCountry: "CZ",
      }),
    ).toEqual({
      street: "Jankovcova 1522/53",
      city: "Brno",
      postalCode: "170 00",
      country: "CZ",
    });
  });

  test("updates untouched default country on empty forms, respects includeCountry: false, and keeps explicit countries", () => {
    expect(
      applyAddressPaste(emptyCzech, "street", "Friedrichstraße 123, 10117 Berlin, Germany", {
        defaultCountry: "CZ",
      }),
    ).toEqual({
      street: "Friedrichstraße 123",
      city: "Berlin",
      postalCode: "10117",
      country: "DE",
    });

    expect(
      applyAddressPaste(emptyCzech, "street", "Friedrichstraße 123, 10117 Berlin, Germany", {
        includeCountry: false,
      }),
    ).toEqual({
      street: "Friedrichstraße 123",
      city: "Berlin",
      postalCode: "10117",
      country: "CZ",
    });

    const explicitCountry: AddressFields = {
      street: "",
      city: "",
      postalCode: "",
      country: "SK",
    };
    expect(
      applyAddressPaste(explicitCountry, "street", "Friedrichstraße 123, 10117 Berlin, Germany", {
        defaultCountry: "CZ",
      }),
    ).toEqual({
      street: "Friedrichstraße 123",
      city: "Berlin",
      postalCode: "10117",
      country: "SK",
    });
  });

  test("does not intercept a paste when nothing extracts for the target and sibling fields are already filled", () => {
    const filled: AddressFields = {
      street: "Office 2",
      city: "Brno",
      postalCode: "602 00",
      country: "CZ",
    };
    expect(applyAddressPaste(filled, "street", "170 00 Praha 7")).toBeUndefined();
  });

  test("still intercepts re-pasting the same full address into its target field", () => {
    const filled: AddressFields = {
      street: "Jankovcova 1522/53",
      city: "Praha 7",
      postalCode: "170 00",
      country: "CZ",
    };
    expect(applyAddressPaste(filled, "street", "Jankovcova 1522/53, 170 00 Praha 7")).toEqual(
      filled,
    );
  });
});

describe("applyAddressInputChange", () => {
  test("ignores incremental typing and splits pasted multi-character values", () => {
    expect(
      applyAddressInputChange(
        { street: "Jankovcova 1522/53, 170 00 Praha ", city: "", postalCode: "", country: "CZ" },
        "street",
        "Jankovcova 1522/53, 170 00 Praha 7",
      ),
    ).toBeUndefined();

    expect(
      applyAddressInputChange(emptyCzech, "street", "Jankovcova 1522/53, 170 00 Praha 7"),
    ).toEqual({
      street: "Jankovcova 1522/53",
      city: "Praha 7",
      postalCode: "170 00",
      country: "CZ",
    });
  });
});
