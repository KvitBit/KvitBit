import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const Step = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const DeployWorkflow = Schema.Struct({
  on: Schema.Struct({
    workflow_dispatch: Schema.Struct({
      inputs: Schema.JsonObject,
    }),
  }),
  jobs: Schema.Struct({
    deploy: Schema.Struct({ steps: Schema.Array(Step) }),
  }),
});

const decode = Schema.decodeUnknownEffect(DeployWorkflow);

export const parseDeployWorkflow = (yaml: string) =>
  decode(Bun.YAML.parse(yaml)).pipe(Effect.runSync);
