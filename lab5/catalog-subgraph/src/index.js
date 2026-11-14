require("./tracing");

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { ApolloServer } = require("@apollo/server");
const { startStandaloneServer } = require("@apollo/server/standalone");
const { buildSubgraphSchema } = require("@apollo/subgraph");
const { parse } = require("graphql");
const { Pool } = require("pg");
const { createLoaders } = require("./dataloaders");
const { createResolvers } = require("./resolvers");
const { shutdownTracing } = require("./tracing");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://travel_user:travel_password@localhost:5432/travel_aggregator",
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

const typeDefs = parse(
  readFileSync(join(__dirname, "schema.graphql"), "utf8"),
);
const server = new ApolloServer({
  schema: buildSubgraphSchema([
    {
      typeDefs,
      resolvers: createResolvers(pool),
    },
  ]),
});

async function start() {
  const port = Number(process.env.PORT ?? 4001);
  const { url } = await startStandaloneServer(server, {
    listen: { port, host: "0.0.0.0" },
    context: async () => ({ loaders: createLoaders(pool) }),
  });
  console.log(`Catalog subgraph ready at ${url}`);

  const shutdown = async (signal) => {
    console.log(`Received ${signal}; shutting down catalog subgraph`);
    await server.stop();
    await pool.end();
    await shutdownTracing();
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error("Failed to shut down catalog subgraph:", error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error("Failed to shut down catalog subgraph:", error);
      process.exitCode = 1;
    });
  });
}

start().catch(async (error) => {
  console.error("Failed to start catalog subgraph:", error);
  await pool.end();
  await shutdownTracing();
  process.exitCode = 1;
});
