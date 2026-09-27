import { Pool } from "pg";
import { env } from "../config/env";

export const pool = new Pool({ connectionString: env.databaseUrl });

pool.on("error", (err) => {
  // A background client error shouldn't crash the whole process.
  console.error("Unexpected Postgres error on idle client", err);
});
