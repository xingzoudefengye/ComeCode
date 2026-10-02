import { createProjectId } from "../deps.js";
import type { ProjectId } from "../deps.js";

const SESSION_TITLE_MAX_CHARS = 30;

export function titleFromInput(input: string): string {
  const compact = input.trim().replace(/\s+/g, " ");
  if (!compact) return "Untitled session";
  return compact.length <= SESSION_TITLE_MAX_CHARS
    ? compact
    : `${compact.slice(0, SESSION_TITLE_MAX_CHARS - 3)}...`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(slugify(directory).slice(0, 80) || "default");
}
