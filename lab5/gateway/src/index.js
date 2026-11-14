require("./tracing");

const { ApolloGateway, IntrospectAndCompose } = require("@apollo/gateway");
const { ApolloServer } = require("@apollo/server");
const { ApolloServerPluginDrainHttpServer } = require("@apollo/server/plugin/drainHttpServer");
const { expressMiddleware } = require("@as-integrations/express5");
const { createServer } = require("node:http");
const cors = require("cors");
const express = require("express");
const depthLimit = require("graphql-depth-limit");
const { shutdownTracing } = require("./tracing");

const subgraphs = [
  {
    name: "catalog",
    url:
      process.env.CATALOG_SUBGRAPH_URL ??
      "http://catalog-subgraph:4001/graphql",
  },
  {
    name: "external",
    url:
      process.env.EXTERNAL_SUBGRAPH_URL ??
      "http://external-subgraph:4002/graphql",
  },
  {
    name: "reviews",
    url:
      process.env.REVIEWS_SUBGRAPH_URL ??
      "http://reviews-subgraph:4003/graphql",
  },
];

const MAX_STARTUP_ATTEMPTS = 15;
const STARTUP_RETRY_DELAY_MS = 2_000;

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForSubgraphs() {
  for (let attempt = 1; attempt <= MAX_STARTUP_ATTEMPTS; attempt += 1) {
    const results = await Promise.all(
      subgraphs.map(async ({ name, url }) => {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ query: "{ _service { sdl } }" }),
            signal: AbortSignal.timeout(3_000),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          const result = await response.json();
          if (!result.data?._service?.sdl) {
            throw new Error("Federation service SDL is not available");
          }
          return { name, ready: true };
        } catch (error) {
          return { name, ready: false, error };
        }
      }),
    );

    const unavailable = results.filter((result) => !result.ready);
    if (unavailable.length === 0) {
      return;
    }

    const details = unavailable
      .map(({ name, error }) => `${name}: ${error.message}`)
      .join("; ");
    if (attempt === MAX_STARTUP_ATTEMPTS) {
      throw new Error(
        `Subgraphs did not become ready after ${MAX_STARTUP_ATTEMPTS} attempts: ${details}`,
      );
    }
    console.warn(
      `Waiting for subgraphs (${attempt}/${MAX_STARTUP_ATTEMPTS}): ${details}`,
    );
    await sleep(STARTUP_RETRY_DELAY_MS);
  }
}

function createRequestLoggingPlugin() {
  return {
    async requestDidStart(requestContext) {
      const startedAt = performance.now();
      const operationName = requestContext.request.operationName ?? "anonymous";

      return {
        async willSendResponse(context) {
          const errors = context.response.body.kind === "single"
            ? context.response.body.singleResult.errors
            : undefined;
          const status = errors?.length ? "error" : "success";
          const durationMs = (performance.now() - startedAt).toFixed(2);
          console.log(
            `GraphQL ${operationName} ${durationMs}ms ${status}`,
          );
        },
      };
    },
  };
}

async function start() {
  await waitForSubgraphs();

  const gateway = new ApolloGateway({
    supergraphSdl: new IntrospectAndCompose({ subgraphs }),
  });
  const app = express();
  const httpServer = createServer(app);
  const server = new ApolloServer({
    gateway,
    validationRules: [depthLimit(6)],
    plugins: [
      ApolloServerPluginDrainHttpServer({ httpServer }),
      createRequestLoggingPlugin(),
    ],
  });
  const port = Number(process.env.PORT ?? 4000);
  await server.start();
  app.use(
    "/",
    cors({
      origin: [
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
      ],
      credentials: true,
    }),
    express.json(),
    expressMiddleware(server),
  );
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "0.0.0.0", resolve);
  });
  console.log(`Apollo Gateway ready at http://localhost:${port}/`);

  const shutdown = async (signal) => {
    console.log(`Received ${signal}; shutting down gateway`);
    await server.stop();
    await shutdownTracing();
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error("Failed to shut down gateway:", error);
      process.exitCode = 1;
    });
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error("Failed to shut down gateway:", error);
      process.exitCode = 1;
    });
  });
}

start().catch(async (error) => {
  console.error("Failed to start Apollo Gateway:", error);
  await shutdownTracing();
  process.exitCode = 1;
});
