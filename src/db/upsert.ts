import { getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

/** `set` for an upsert that overwrites every column except the key. */
export const overwriteAll = (table: PgTable, key = "id") =>
  Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([name]) => name !== key)
      .map(([name, column]) => [name, sql.raw(`excluded."${column.name}"`)]),
  );
