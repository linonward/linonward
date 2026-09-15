import { createDeepSeekAgentCli } from "../src/agent-cli.js";
import { EXIT_CODES } from "../src/index.js";

async function main(): Promise<void> {
  const run = await createDeepSeekAgentCli();
  process.exitCode = await run(process.argv.slice(2));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = EXIT_CODES.usage;
});
