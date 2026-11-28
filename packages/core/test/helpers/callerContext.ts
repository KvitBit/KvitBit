import type { Caller } from "@kvitbit/domain/contract";
import * as Context from "effect/Context";

/** A scenario's default caller for test programs shared by several identities. */
export class TestCaller extends Context.Service<TestCaller, Caller>()(
  "@kvitbit/core/test/helpers/callerContext/TestCaller",
) {}
