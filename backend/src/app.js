import express from "express";
import { createApiRouter } from "./routes/api.js";

export function createApp(dependencies) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter(dependencies));
  app.use((error, _request, response, _next) => {
    const message = error.message ?? "";
    const status = message.startsWith("A scrape job is already running")
      ? 409
      : message.startsWith("Pagination") || message.startsWith("Unknown dry-run category")
        ? 400
        : 500;
    response.status(status).json({ error: message });
  });
  return app;
}
