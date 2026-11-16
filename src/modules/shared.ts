import { z } from "zod";

const MAX_POSTGRES_INT = 2_147_483_647;

export const articleParamsSchema = z.object({
  id: z.coerce.number().int().positive().max(MAX_POSTGRES_INT),
});

export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
