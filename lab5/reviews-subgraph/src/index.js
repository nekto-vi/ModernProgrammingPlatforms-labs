require("./tracing");

const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { createServer } = require("node:http");
const express = require("express");
const cors = require("cors");
const { ApolloServer } = require("@apollo/server");
const { ApolloServerPluginDrainHttpServer } = require("@apollo/server/plugin/drainHttpServer");
const { expressMiddleware } = require("@as-integrations/express5");
const { buildSubgraphSchema } = require("@apollo/subgraph");
const { parse } = require("graphql");
const { RedisPubSub } = require("graphql-redis-subscriptions");
const { useServer } = require("graphql-ws/use/ws");
const Redis = require("ioredis");
const { Pool } = require("pg");
const { WebSocketServer } = require("ws");
const { createLoaders } = require("./dataloaders");
const { createResolvers } = require("./resolvers");
const { shutdownTracing } = require("./tracing");

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://travel_user:travel_password@localhost:5432/travel_aggregator",
});
const publisher = new Redis(redisUrl);
const subscriber = new Redis(redisUrl);
const pubsub = new RedisPubSub({ publisher, subscriber });

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});
publisher.on("error", (error) => {
  console.error("Redis publisher error:", error);
});
subscriber.on("error", (error) => {
  console.error("Redis subscriber error:", error);
});

const typeDefs = parse(
  readFileSync(join(__dirname, "schema.graphql"), "utf8"),
);
const schema = buildSubgraphSchema([
  {
    typeDefs,
    resolvers: createResolvers(pool, pubsub),
  },
]);
const app = express();
const httpServer = createServer(app);
const wsServer = new WebSocketServer({ server: httpServer, path: "/graphql" });
const wsServerCleanup = useServer(
  {
    schema,
    context: async () => ({ pubsub, loaders: createLoaders(pool) }),
  },
  wsServer,
);
const server = new ApolloServer({
  schema,
  plugins: [
    ApolloServerPluginDrainHttpServer({ httpServer }),
    {
      async serverWillStart() {
        return {
          async drainServer() {
            await wsServerCleanup.dispose();
            await pubsub.close();
            await pool.end();
            await shutdownTracing();
          },
        };
      },
    },
  ],
});

async function start() {
  const port = Number(process.env.PORT ?? 4003);
  await server.start();
  app.use(
    "/graphql",
    cors(),
    express.json(),
    expressMiddleware(server, {
      context: async () => ({ pubsub, loaders: createLoaders(pool) }),
    }),
  );
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "0.0.0.0", resolve);
  });
  console.log(
    `Reviews subgraph ready at http://localhost:${port}/graphql and ws://localhost:${port}/graphql`,
  );
}

start().catch(async (error) => {
  console.error("Failed to start reviews subgraph:", error);
  await wsServerCleanup.dispose();
  await pubsub.close();
  await pool.end();
  await shutdownTracing();
  process.exitCode = 1;
});
