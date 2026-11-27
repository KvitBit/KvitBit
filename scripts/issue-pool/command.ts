import { PoolError } from "./pool";

export type Command = (
  executable: string,
  args: readonly string[],
  input?: string,
) => Promise<string>;

export const runCommand: Command = async (executable, args, input) => {
  const child = Bun.spawn([executable, ...args], {
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "ignore",
    timeout: 90_000,
    killSignal: "SIGKILL",
    env: { ...Bun.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (status !== 0) {
    throw new PoolError(`${executable} failed with exit status ${status}`);
  }
  return output;
};
