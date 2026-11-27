import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CryptoDigestAlgorithm, digestStringAsync } from "expo-crypto";

export const jsonText = Fn.flow(
  Schema.encodeOption(Schema.fromJsonString(Schema.Json)),
  Option.getOrThrow,
);

export const sha256 = (text: string) => digestStringAsync(CryptoDigestAlgorithm.SHA256, text);

export const requestIntentSlot = ([owner, operation]: readonly [string, string]) =>
  sha256(jsonText([owner, operation])).then((hash) => `kvitbit.request-intent.v1.${hash}`);
