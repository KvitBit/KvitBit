import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  Caller,
  CurrentCaller,
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

const userId = Schema.decodeUnknownSync(UserId)("u1");

describe("Caller", () => {
  test("edge constructors stamp the tag", () => {
    const account = Caller.account({ userId, email: "a@b.cz", locale: "cs", channel: "web" });
    expect(account._tag).toBe("Account");
    const visitor = Caller.shareLinkVisitor({
      token: Schema.decodeUnknownSync(ShareToken)("v1.abc"),
      visitor: Schema.decodeUnknownSync(VisitorHash)("h"),
      locale: "en",
    });
    expect(visitor._tag).toBe("ShareLinkVisitor");
    expect("signedInUser" in visitor).toBe(false);
    const holder = Caller.invitationHolder({
      token: Schema.decodeUnknownSync(InvitationToken)("t"),
      locale: "cs",
    });
    expect(holder._tag).toBe("InvitationHolder");
    expect([account, visitor, holder].map(describeCaller)).toEqual([
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
    expect(Object.keys(Caller).sort()).toEqual(["account", "invitationHolder", "shareLinkVisitor"]);
    const literal = {
      _tag: "System",
      workspaceId: Schema.decodeUnknownSync(WorkspaceId)("w"),
      job: { _tag: "DataExport" },
    };
    // @ts-expect-error the seal key is not nameable outside caller.ts
    const forged: SystemCaller = literal;
    expect(forged._tag).toBe("System");
  });

  test("CurrentCaller is a Context service keyed kvitbit/Caller", async () => {
    expect(CurrentCaller.key).toBe("kvitbit/Caller");
    const caller = Caller.account({ userId, email: "a@b.cz", locale: "en", channel: "api" });
    const tag = await Effect.runPromise(
      Effect.gen(function* () {
        return describeCaller(yield* CurrentCaller);
      }).pipe(Effect.provideService(CurrentCaller, caller)),
    );
    expect(tag).toBe("account:a@b.cz");
  });
});
