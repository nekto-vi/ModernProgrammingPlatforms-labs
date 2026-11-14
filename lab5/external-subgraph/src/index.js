require("./tracing");

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ApolloServer } = require("@apollo/server");
const { startStandaloneServer } = require("@apollo/server/standalone");
const { buildSubgraphSchema } = require("@apollo/subgraph");
const { parse } = require("graphql");
const { resolvers } = require("./resolvers");
const { closeRedis } = require("./services");
const { shutdownTracing } = require("./tracing");

const typeDefs = parse(
  readFileSync(join(__dirname, "schema.graphql"), "utf8"),
);
const server = new ApolloServer({
  schema: buildSubgraphSchema([{ typeDefs, resolvers }]),
});

async function start() {
  const port = Number(process.env.PORT ?? 4002);
  const { url } = await startStandaloneServer(server, {
    listen: { port, host: "0.0.0.0" },
  });
  console.log(`External subgraph ready at ${url}`);
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down external subgraph`);
  await server.stop();
  await closeRedis();
  await shutdownTracing();
}

process.once("SIGINT", () => {
  shutdown("SIGINT").catch((error) => {
    console.error("Failed to shut down external subgraph:", error);
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM").catch((error) => {
    console.error("Failed to shut down external subgraph:", error);
    process.exitCode = 1;
  });
});

start().catch(async (error) => {
  console.error("Failed to start external subgraph:", error);
  await closeRedis();
  await shutdownTracing();
  process.exitCode = 1;
});
