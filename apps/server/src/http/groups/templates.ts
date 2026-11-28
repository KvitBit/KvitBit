/** `templates` group handlers (http-mcp-contracts 3.5.4): templates, recurring schedules, runs. */
import { API_PREFIX, Api, RequestCaller } from "@kvitbit/api-contract";
import { Templates } from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Predicate from "effect/Predicate";
import { compact, requestOptions, setLocation, withRevision } from "../conventions";
import { jsonizeDocumentView } from "./documents/jsonize";
import { jsonizeTemplate } from "./records/json";

export const TemplatesGroupLive = HttpApiBuilder.group(
  Api,
  "templates",
  Effect.fnUntraced(function* (handlers) {
    const templates = yield* Templates;
    return handlers
      .handle("list", () =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(templates.list(caller), Arr.map(jsonizeTemplate)),
        ),
      )
      .handle("get", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(templates.get(caller, params.templateId), jsonizeTemplate),
        ),
      )
      .handle("create", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          templates.save(caller, payload, requestOptions(headers)).pipe(
            Effect.map(jsonizeTemplate),
            Effect.tap((view) => {
              if (!Predicate.isString(view["id"])) return Effect.void;
              return setLocation(
                `${API_PREFIX}/workspaces/${params.workspaceId}/templates/${view["id"]}`,
              );
            }),
          ),
        ),
      )
      .handle("update", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            Effect.map(
              templates.save(caller, { ...payload, id: params.templateId, expectedRevision }),
              jsonizeTemplate,
            ),
          ),
        ),
      )
      .handle("archive", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) => templates.archive(caller, params.templateId)),
      )
      .handle("setSchedule", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            Effect.map(
              templates.schedule(caller, params.templateId, payload, expectedRevision),
              jsonizeTemplate,
            ),
          ),
        ),
      )
      .handle("removeSchedule", ({ params, headers }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            Effect.map(
              templates.schedule(caller, params.templateId, null, expectedRevision),
              jsonizeTemplate,
            ),
          ),
        ),
      )
      .handle("resume", ({ params }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(templates.resume(caller, params.templateId), jsonizeTemplate),
        ),
      )
      .handle("runs", ({ params, query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          templates.runs(caller, params.templateId, compact(query)),
        ),
      )
      .handle("use", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          templates.use(caller, params.templateId, payload, requestOptions(headers)).pipe(
            Effect.map(jsonizeDocumentView),
            Effect.tap((view) =>
              setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/documents/${view.id}`),
            ),
          ),
        ),
      );
  }),
);
