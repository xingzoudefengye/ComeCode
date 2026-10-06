import { Lexer, type Tokens } from "marked";
import { memorySnapshotFiles } from "./context-projection.js";

export interface MemorySearchResult {
  file: string;
  title?: string;
  excerpt: string;
  score: number;
}

export interface MemorySearchOptions {
  maxResults?: number;
  maxChars?: number;
}

interface SearchDocument {
  file: string;
  title?: string;
  text: string;
  excerpt: string;
  order: number;
}

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS = 20;
const DEFAULT_MAX_CHARS = 8_000;
const K1 = 1.5;
const B = 0.75;

export function searchMemorySnapshot(
  snapshot: string | undefined,
  query: string,
  options: MemorySearchOptions = {},
): MemorySearchResult[] {
  const normalizedQuery = query.trim();
  if (!snapshot?.trim() || !normalizedQuery) return [];
  const documents = buildDocuments(snapshot);
  const queryTerms = tokenize(normalizedQuery);
  if (!queryTerms.length || !documents.length) return [];
  const documentTerms = documents.map((document) => tokenize(document.text));
  const averageLength = documentTerms.reduce((sum, terms) => sum + terms.length, 0) / documentTerms.length;
  const documentFrequency = new Map<string, number>();
  for (const terms of documentTerms) {
    for (const term of new Set(terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const scored = documents
    .map((document, index) => ({
      document,
      score: scoreDocument(queryTerms, documentTerms[index]!, documentFrequency, documents.length, averageLength),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.document.order - right.document.order);
  const maxResults = Math.min(MAX_RESULTS, Math.max(1, Math.trunc(options.maxResults ?? DEFAULT_MAX_RESULTS)));
  const maxChars = Math.max(200, Math.trunc(options.maxChars ?? DEFAULT_MAX_CHARS));
  const results: MemorySearchResult[] = [];
  let chars = 0;
  for (const item of scored.slice(0, maxResults)) {
    const result: MemorySearchResult = {
      file: item.document.file,
      ...(item.document.title ? { title: item.document.title } : {}),
      excerpt: item.document.excerpt,
      score: Number(item.score.toFixed(4)),
    };
    const cost = JSON.stringify(result).length;
    if (results.length > 0 && chars + cost > maxChars) break;
    results.push(result);
    chars += cost;
  }
  return results;
}

export function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.toLocaleLowerCase().matchAll(/[a-z0-9]+(?:[-_][a-z0-9]+)*|[\p{Script=Han}]/gu)) {
    const term = match[0]!;
    terms.push(term);
  }
  const han = [...text.toLocaleLowerCase().matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap((match) => {
    const chars = [...match[0]!];
    return chars.slice(0, -1).map((_, index) => chars.slice(index, index + 2).join(""));
  });
  return [...terms, ...han];
}

function scoreDocument(
  queryTerms: readonly string[],
  documentTerms: readonly string[],
  documentFrequency: ReadonlyMap<string, number>,
  documentCount: number,
  averageLength: number,
): number {
  const frequencies = new Map<string, number>();
  for (const term of documentTerms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return queryTerms.reduce((score, term) => {
    const frequency = frequencies.get(term) ?? 0;
    if (!frequency) return score;
    const df = documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
    const denominator = frequency + K1 * (1 - B + B * (documentTerms.length / Math.max(1, averageLength)));
    return score + idf * ((frequency * (K1 + 1)) / denominator);
  }, 0);
}

function buildDocuments(snapshot: string): SearchDocument[] {
  const documents: SearchDocument[] = [];
  let order = 0;
  for (const [file, content] of memorySnapshotFiles(snapshot)) {
    for (const unit of markdownUnits(content)) {
      documents.push({ file, title: unit.title, text: `${unit.title ?? ""}\n${unit.body}`, excerpt: unit.body.slice(0, 600), order });
      order += 1;
    }
  }
  return documents;
}

function markdownUnits(content: string): Array<{ title?: string; body: string }> {
  const units: Array<{ title?: string; body: string }> = [];
  let heading: string | undefined;
  for (const token of Lexer.lex(content.replace(/\r\n/gu, "\n"))) {
    if (token.type === "heading") {
      heading = token.text.trim();
      continue;
    }
    if (token.type === "space" || token.type === "html" || token.type === "def") continue;
    const parts = token.type === "list" ? token.items.map((item: Tokens.ListItem) => item.raw.trim()) : [token.raw.trim()];
    for (const body of parts) if (body) units.push({ title: heading, body });
  }
  return units;
}
