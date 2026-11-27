/**
 * CLI entrypoint executed by `.github/workflows/deploy.yml` in the
 * "Validate GCP deployment variables" step.
 */
import { appendFileSync } from "node:fs";
import { SECRET_FLAG_ENV_VARS, validateDeployPreflight } from "./deploy-preflight";

const result = validateDeployPreflight(process.env);
if (!result.ok) {
  process.stdout.write(`::error::${result.message}\n`);
  process.exit(1);
}

const githubEnvPath = process.env.GITHUB_ENV;
if (githubEnvPath !== undefined && githubEnvPath.length > 0) {
  const lines = SECRET_FLAG_ENV_VARS.map(
    (name) => `${name}=${result.normalizedBooleans[name] ? "true" : "false"}\n`,
  ).join("");
  appendFileSync(githubEnvPath, lines, "utf8");
}
