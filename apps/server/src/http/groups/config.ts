/** `config` group handler (http-mcp-contracts 3.5.1): public install configuration. */
import {
  Api,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  BRANDING_IMAGE_MAX_BYTES,
  BRANDING_IMAGE_TYPES,
  THEME_JSON_MAX_BYTES,
} from "@kvitbit/api-contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpConfig } from "../config";

export const ConfigGroupLive = HttpApiBuilder.group(Api, "config", (handlers) =>
  Effect.gen(function* () {
    const config = yield* HttpConfig;
    return handlers.handle("getConfig", () =>
      Effect.succeed({
        version: config.version,
        botProtection: config.botProtection,
        analytics: { posthog: config.posthog },
        uploads: {
          attachment: {
            maxBytes: ATTACHMENT_MAX_BYTES,
            types: [...ATTACHMENT_TYPES],
          },
          brandingImage: {
            maxBytes: BRANDING_IMAGE_MAX_BYTES,
            types: [...BRANDING_IMAGE_TYPES],
          },
          themeJson: {
            maxBytes: THEME_JSON_MAX_BYTES,
          },
        },
        features: {
          signUp: config.signUp,
          mcp: true,
          apiKeys: true,
        },
      }),
    );
  }),
);
