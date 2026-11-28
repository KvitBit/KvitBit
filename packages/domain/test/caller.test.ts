import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import {
  Caller,
  ExportId,
  InvitationToken,
  ShareToken,
  type SystemCaller,
  UserId,
  VisitorHash,
  WorkspaceId,
} from "../src/index";

/** Fails to compile if a Caller variant is added without a case here. */
const describeCaller = (caller: Caller): string => {
  switch (caller._tag) {
    case "Member":
      return `member:${caller.role}`;
    case "Account":
      return `account:${caller.email}`;
    case "ShareLinkVisitor":
      return "visitor";
    case "InvitationHolder":
      return "invitation";
    case "System":
      return `system:${caller.job._tag}`;
    default: {
      const unreachable: never = caller;
      return unreachable;
    }
  }
};

const userId = UserId.make("0192f0c4-1b2c-7d3e-8f40-0123456789ab");

describe("Caller", () => {
  test("edge constructors stamp the tag", () => {
    const account = Caller.account({ userId, email: "a@b.cz", locale: "cs", channel: "web" });
    expect(account._tag).toBe("Account");
    const visitor = Caller.shareLinkVisitor({
      token: ShareToken.make("v1.abc"),
      visitor: VisitorHash.make("h"),
      locale: "en",
    });
    expect(visitor._tag).toBe("ShareLinkVisitor");
    expect("signedInUser" in visitor).toBe(false);
    const holder = Caller.invitationHolder({
      token: InvitationToken.make("t"),
      locale: "cs",
    });
    expect(holder._tag).toBe("InvitationHolder");
    expect(Arr.map([account, visitor, holder], describeCaller)).toEqual([
      "account:a@b.cz",
      "visitor",
      "invitation",
    ]);
  });

  test("a spread input cannot override the tag", () => {
    const sneaky = { userId, email: "x", locale: "cs", channel: "web", _tag: "Member" } as const;
    expect(Caller.account(sneaky)._tag).toBe("Account");
  });

  test("there is no System constructor and no literal satisfies SystemCaller", () => {
    expect(Arr.sort(Record.keys(Caller), Order.String)).toEqual([
      "account",
      "invitationHolder",
      "shareLinkVisitor",
    ]);
    // Every public field is present and correctly typed, so only the seal makes this fail.
    const literal = {
      _tag: "System" as const,
      workspaceId: WorkspaceId.make("0192f0c4-1b2c-7d3e-8f40-0123456789ac"),
      job: {
        _tag: "DataExport" as const,
        exportId: ExportId.make("0192f0c4-1b2c-7d3e-8f40-0123456789ad"),
      },
    };
    // @ts-expect-error the seal key is not nameable outside caller.ts
    const forged: SystemCaller = literal;
    expect(forged._tag).toBe("System");
  });
});
