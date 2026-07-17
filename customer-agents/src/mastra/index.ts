import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";

import { customerServiceAgent } from "./agents/customer-service-agent";

export const mastra = new Mastra({
  agents: { customerServiceAgent },
  storage: new LibSQLStore({
    id: "mastra-storage",
    url: process.env.MASTRA_STORAGE_URL ?? "file:./mastra.db",
  }),
});
