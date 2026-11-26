/**
 * Temporary scaffold: a group layer whose every endpoint dies. Replaced group by group by the
 * real handlers; nothing may use it once every group is implemented.
 */
import { Api } from "@kvitbit/api-contract";
import { Effect, type Layer } from "effect";
import { HttpApiBuilder, type HttpApiGroup } from "effect/http-api";

type GroupId = HttpApiGroup.Identifier<(typeof Api)["groups"][keyof (typeof Api)["groups"]]>;

export const unimplemented = <const Id extends GroupId>(
  id: Id,
): Layer.Layer<HttpApiGroup.Service<"kvitbit", Id>> =>
  HttpApiBuilder.group(Api, id, (handlers) => {
    // biome-ignore lint/suspicious/noExplicitAny: scaffold over every endpoint of a group
    let h: any = handlers;
    // biome-ignore lint/suspicious/noExplicitAny: scaffold over every endpoint of a group
    const group = (Api.groups as any)[id] as HttpApiGroup.Top;
    for (const name of Object.keys(group.endpoints)) {
      h = h.handle(name, () => Effect.die(`not implemented: ${id}.${name}`));
    }
    return h;
  }) as never;
