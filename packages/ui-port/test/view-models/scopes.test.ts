import { describe, expect, test } from "bun:test";
import { ALL_SCOPES, type GrantedAccess, READ_SCOPES, type Scope } from "@kvitbit/api-contract";
import { Option } from "effect";
import {
  consentDiff,
  describeAccess,
  effectiveScopes,
  fromOAuthScopes,
  presetAvailable,
  roleScopeCeiling,
  ScopePicker,
  toAccessRequest,
  toOAuthScopes,
} from "../../src/view-models";

const owner = roleScopeCeiling("owner");
const accountant = roleScopeCeiling("accountant");

describe("role ceiling", () => {
  test("owner, admin and member may grant all twenty; accountant only the ten reads", () => {
    expect(owner.size).toBe(20);
    expect(roleScopeCeiling("admin").size).toBe(20);
    expect(roleScopeCeiling("member").size).toBe(20);
    expect([...accountant]).toEqual([...READ_SCOPES]);
  });

  test("accountant: write is clamped to read, toggling write does nothing, read_write preset is disabled", () => {
    let s = ScopePicker.init(accountant);
    expect(presetAvailable(s, "read")).toBe(true);
    expect(presetAvailable(s, "read_write")).toBe(false);
    expect(ScopePicker.choosePreset(s, "read_write")).toBe(s);
    s = ScopePicker.setArea(s, "documents", "write");
    expect(effectiveScopes(s)).toEqual(["documents:read"]);
    expect(ScopePicker.toggle(s, "contacts:write")).toBe(s);
    const rows = ScopePicker.rows(s);
    expect(rows.every((r) => !r.writeEnabled && r.readEnabled)).toBe(true);
    expect(rows.find((r) => r.area === "documents")?.level).toBe("read");
  });
});

describe("matrix reducer", () => {
  test("write implies read; unchecking read clears write", () => {
    let s = ScopePicker.init(owner);
    s = ScopePicker.toggle(s, "payments:write");
    expect(effectiveScopes(s)).toEqual(["payments:read", "payments:write"]);
    s = ScopePicker.toggle(s, "payments:write");
    expect(effectiveScopes(s)).toEqual(["payments:read"]);
    s = ScopePicker.toggle(s, "payments:write");
    s = ScopePicker.toggle(s, "payments:read");
    expect(effectiveScopes(s)).toEqual([]);
    expect(Option.isNone(toAccessRequest(s))).toBe(true);
  });

  test("presets and switching to custom keeps the preset's scopes", () => {
    let s = ScopePicker.choosePreset(ScopePicker.init(owner), "read");
    expect(toAccessRequest(s)).toEqual(Option.some({ access: "read" }));
    expect(effectiveScopes(s)).toEqual(READ_SCOPES);
    s = ScopePicker.setArea(s, "share", "write");
    expect(s.mode).toBe("custom");
    expect(effectiveScopes(s)).toHaveLength(11);
    s = ScopePicker.choosePreset(s, "read_write");
    expect(effectiveScopes(s)).toEqual(ALL_SCOPES);
    s = ScopePicker.setArea(ScopePicker.chooseCustom(s), "members", "none");
    expect(effectiveScopes(s)).toHaveLength(18);
  });

  test("a custom request outside the ceiling is capped on load", () => {
    const s = ScopePicker.init(accountant, {
      access: "custom",
      scopes: ["documents:write", "reports:read"],
    });
    expect(effectiveScopes(s)).toEqual(["documents:read", "reports:read"]);
    // read_write preset does not fit the accountant ceiling: custom with reads
    const p = ScopePicker.init(accountant, { access: "read_write" });
    expect(p.mode).toBe("custom");
    expect(effectiveScopes(p)).toEqual(READ_SCOPES);
  });
});

describe("contract scope strings", () => {
  const cases: ReadonlyArray<GrantedAccess> = [
    { access: "read", scopes: READ_SCOPES },
    { access: "read_write", scopes: ALL_SCOPES },
    { access: "custom", scopes: ["contacts:read", "documents:read", "documents:write"] },
  ];
  for (const granted of cases) {
    test(`round-trips ${granted.access} through OAuth wire scopes`, () => {
      const s = ScopePicker.forConsent(granted, owner);
      const wire = toOAuthScopes(s);
      expect(fromOAuthScopes(wire)).toEqual(Option.some(granted));
      expect(effectiveScopes(s)).toEqual(granted.scopes);
    });
  }

  test("presets use the preset tokens; offline_access alone grants nothing", () => {
    expect(toOAuthScopes(ScopePicker.choosePreset(ScopePicker.init(owner), "read"))).toEqual([
      "kvitbit:read",
    ]);
    expect(toOAuthScopes(ScopePicker.init(owner))).toEqual([]);
    expect(Option.isNone(fromOAuthScopes(["offline_access"]))).toBe(true);
  });

  test("describeAccess renders one row per area", () => {
    const rows = describeAccess({
      access: "custom",
      scopes: ["documents:read", "documents:write", "share:read"],
    });
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => r.level !== "none")).toEqual([
      { area: "documents", level: "write" },
      { area: "share", level: "read" },
    ]);
  });
});

describe("MCP consent", () => {
  test("accountant keeps the requested read subset, writes dropped; diff shows what was withheld", () => {
    const requested: GrantedAccess = {
      access: "custom",
      scopes: ["contacts:read", "documents:read", "documents:write"],
    };
    const s = ScopePicker.forConsent(requested, accountant);
    expect(s.mode).toBe("custom");
    expect([...s.grantable]).toEqual(["contacts:read", "documents:read"]);
    expect(effectiveScopes(s)).toEqual(["contacts:read", "documents:read"]);
    expect(consentDiff(requested, s)).toEqual({
      granted: ["contacts:read", "documents:read"],
      withheld: ["documents:write"],
      extra: [],
      narrowed: true,
    });
  });

  test("a requested preset that fits opens in preset mode; the user can only narrow", () => {
    const requested: GrantedAccess = { access: "read", scopes: READ_SCOPES };
    let s = ScopePicker.forConsent(requested, owner);
    expect(s.mode).toBe("read");
    expect(presetAvailable(s, "read_write")).toBe(false);
    s = ScopePicker.toggle(s, "documents:write" as Scope); // not offerable
    expect(effectiveScopes(s)).toEqual(READ_SCOPES);
    s = ScopePicker.setArea(s, "members", "none");
    expect(consentDiff(requested, s)).toMatchObject({
      withheld: ["members:read"],
      extra: [],
      narrowed: true,
    });
  });

  test("read_write request for an accountant opens in custom with the ten reads", () => {
    const s = ScopePicker.forConsent({ access: "read_write", scopes: ALL_SCOPES }, accountant);
    expect(s.mode).toBe("custom");
    expect(effectiveScopes(s)).toEqual(READ_SCOPES);
    expect(toAccessRequest(s)).toEqual(
      Option.some({ access: "custom", scopes: [...READ_SCOPES] as [Scope, ...Scope[]] }),
    );
  });
});
