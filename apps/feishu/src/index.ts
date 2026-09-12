import { loadServiceConfig } from "./config.js";
import { createGitHubDispatcher } from "./github.js";
import { startLongConnection } from "./long-connection.js";

const config = loadServiceConfig(process.env);
const dispatch = createGitHubDispatcher(config.github);

void startLongConnection(config.feishu, config.relay, dispatch).catch((error: unknown) => {
  console.error("Unable to start Feishu long connection", error);
  process.exitCode = 1;
});
