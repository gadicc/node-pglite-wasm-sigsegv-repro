import { PGlite } from "@electric-sql/pglite";

const client = new PGlite();

try {
  await client.query("SELECT 1");
} finally {
  await client.close();
}
