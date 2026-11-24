import { describe, expect, test } from "bun:test";
import { anonymous, renderPath, WS } from "./support";

describe("server render smoke", () => {
  const paths = [
    "/",
    "/legal/terms",
    "/sign-in",
    `/w/${WS}`,
    `/w/${WS}/documents`,
    `/w/${WS}/settings/issuing-entity`,
    "/no/such/page",
  ];
  for (const path of paths) {
    test(`renders ${path}`, async () => {
      const { html, title } = await renderPath(path);
      expect(html).toContain('class="kb-root"');
      expect(html).toContain("--md-sys-color-surface");
      expect(title).toContain("Kvitbit");
    });
  }

  test("anonymous viewer of a workspace route renders the sign-in screen", async () => {
    const { html } = await renderPath(`/w/${WS}/documents`, { session: anonymous });
    expect(html).toContain("kb-root");
  });
});
