import { describe, expect, test } from "bun:test";
import { apiOrigin, parseApiOrigin } from "./env";

describe("api origin", () => {
  test("accepts https and local plain http only", () => {
    expect(parseApiOrigin("https://kvitbit.example/path")).toBe("https://kvitbit.example");
    expect(parseApiOrigin("http://10.0.2.2:8080")).toBe("http://10.0.2.2:8080");
    expect(parseApiOrigin("http://kvitbit.example")).toBeNull();
    expect(parseApiOrigin("")).toBeNull();
  });

  test("the PWA uses its page origin", () => {
    expect(
      apiOrigin({
        env: { EXPO_PUBLIC_API_ORIGIN: "https://other" },
        location: { origin: "https://app.test" },
      }),
    ).toBe("https://app.test");
    expect(
      apiOrigin({ env: { EXPO_PUBLIC_API_ORIGIN: "https://api.test" }, location: undefined }),
    ).toBe("https://api.test");
  });
});
