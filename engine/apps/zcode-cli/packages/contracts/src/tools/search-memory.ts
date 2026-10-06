import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SEARCH_MEMORY_TOOL_NAME = "SearchMemory";
export const SEARCH_MEMORY_DEFAULT_MAX_RESULTS = 5;
export const SEARCH_MEMORY_MAX_RESULTS = 20;

export const SearchMemoryInputSchema = z
  .object({
    query: z.string().trim().min(1).max(4000).describe("Focused terms describing the project memory to find."),
    maxResults: z.number().int().positive().max(SEARCH_MEMORY_MAX_RESULTS).optional().describe("Maximum number of matching memory entries."),
  })
  .strict();
export type SearchMemoryInput = z.infer<typeof SearchMemoryInputSchema>;
export const SearchMemoryInputJsonSchema = toToolJsonSchema(SearchMemoryInputSchema);

export const SearchMemoryResultSchema = z
  .object({
    file: z.string().min(1),
    title: z.string().optional(),
    excerpt: z.string().min(1),
    score: z.number().nonnegative(),
  })
  .strict();
export type SearchMemoryResult = z.infer<typeof SearchMemoryResultSchema>;

export const SearchMemoryOutputSchema = z
  .object({
    status: z.enum(["success", "not_found", "disabled"]),
    query: z.string(),
    results: z.array(SearchMemoryResultSchema),
    truncated: z.boolean(),
    error: z.string().optional(),
  })
  .strict();
export type SearchMemoryOutput = z.infer<typeof SearchMemoryOutputSchema>;
export const SearchMemoryOutputJsonSchema = toToolJsonSchema(SearchMemoryOutputSchema);
