import React from "react";
import ReactDOM from "react-dom/client";
import {
  ApolloClient,
  ApolloLink,
  ApolloProvider,
  HttpLink,
  InMemoryCache,
  split,
} from "@apollo/client";
import { GraphQLWsLink } from "@apollo/client/link/subscriptions";
import { getMainDefinition } from "@apollo/client/utilities";
import { createClient } from "graphql-ws";
import App from "./App.jsx";
import "./styles.css";

const httpLink = new HttpLink({
  uri: import.meta.env.VITE_GRAPHQL_URL ?? "http://localhost:4000/graphql",
});
const wsLink = new GraphQLWsLink(
  createClient({
    url: import.meta.env.VITE_REVIEWS_WS_URL ?? "ws://localhost:4003/graphql",
    retryAttempts: Infinity,
  }),
);
const link = split(
  ({ query }) => {
    const definition = getMainDefinition(query);
    return (
      definition.kind === "OperationDefinition" &&
      definition.operation === "subscription"
    );
  },
  wsLink,
  httpLink,
);
const client = new ApolloClient({
  link: ApolloLink.from([link]),
  cache: new InMemoryCache(),
});

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ApolloProvider client={client}>
      <App />
    </ApolloProvider>
  </React.StrictMode>,
);
