import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for database commands.");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL },
});
