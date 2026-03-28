/**
 * Eidetic plugin tools – Phase 2: Zettelkasten Skill Development.
 *
 * Provides four tools the Hippocampus (Tiny LLM) calls via function-calling:
 *   search_notes(query)                    – keyword search across all notes
 *   get_backlinks(note_id)                 – reverse-link lookup
 *   traverse_graph(start_node, depth)      – BFS link traversal
 *   read_note(filename_or_id)              – full note content + metadata
 */

import { Static, Type } from "@sinclair/typebox";
import { jsonResult } from "../api.js";
import type { AnyAgentTool } from "../api.js";
import type { EideticConfig } from "./config.js";
import type { ZettelNote } from "./zettelkasten.js";
import { ZettelkastenStore } from "./zettelkasten.js";

// ============================================================================
// Shared helpers
// ============================================================================

function formatNote(note: ZettelNote): Record<string, unknown> {
  return {
    id: note.frontmatter.id,
    title: note.frontmatter.title,
    tags: note.frontmatter.tags,
    links: note.frontmatter.links,
    wikilinks: note.wikilinks,
    created: note.frontmatter.created,
    updated: note.frontmatter.updated,
    body: note.body.slice(0, 2000), // guard against huge notes
  };
}

// ============================================================================
// TypeBox schemas
// ============================================================================

const SearchNotesSchema = Type.Object(
  {
    query: Type.String({ description: "The search query (keywords or a short phrase)." }),
    maxResults: Type.Optional(
      Type.Number({ description: "Maximum number of notes to return (default: 8).", minimum: 1 }),
    ),
  },
  { additionalProperties: false },
);
type SearchNotesParams = Static<typeof SearchNotesSchema>;

const NoteIdSchema = Type.Object(
  {
    note_id: Type.String({ description: "Note ID (UUID) or exact title." }),
  },
  { additionalProperties: false },
);
type NoteIdParams = Static<typeof NoteIdSchema>;

function buildTraverseGraphSchema(maxDepth: number) {
  return Type.Object(
    {
      start_node: Type.String({ description: "Note ID (UUID) or exact title to start from." }),
      depth: Type.Optional(
        Type.Number({ description: `Traversal depth (1–${maxDepth}, default: 2).`, minimum: 1 }),
      ),
    },
    { additionalProperties: false },
  );
}

// ============================================================================
// Tool factories
// ============================================================================

export function createEideticTools(opts: {
  storeFactory: () => ZettelkastenStore;
  config?: EideticConfig;
  maxGraphDepth?: number;
}): AnyAgentTool[] {
  const { storeFactory, maxGraphDepth = 3 } = opts;

  // --------------------------------------------------------------------------
  // search_notes
  // --------------------------------------------------------------------------
  const searchNotesTool: AnyAgentTool = {
    name: "search_notes",
    label: "Search Notes",
    description:
      "Search the Zettelkasten knowledge base for notes relevant to a query. " +
      "Returns a ranked list of notes with excerpt and metadata.",
    parameters: SearchNotesSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as SearchNotesParams;
      const query = params.query;
      const maxResults = params.maxResults ?? 8;
      if (!query) {
        return jsonResult({ results: [], error: "query required" });
      }
      const store = storeFactory();
      const results = await store.search(query, maxResults);
      return jsonResult({
        results: results.map((r) => ({
          score: r.score,
          excerpt: r.excerpt,
          note: formatNote(r.note),
        })),
      });
    },
  };

  // --------------------------------------------------------------------------
  // get_backlinks
  // --------------------------------------------------------------------------
  const getBacklinksTool: AnyAgentTool = {
    name: "get_backlinks",
    label: "Get Backlinks",
    description:
      "Find all Zettelkasten notes that link to the given note. " +
      "Accepts a note ID or an exact title. Returns a list of linking notes.",
    parameters: NoteIdSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as NoteIdParams;
      const store = storeFactory();
      const backlinks = await store.backlinks(params.note_id);
      return jsonResult({ backlinks: backlinks.map(formatNote) });
    },
  };

  // --------------------------------------------------------------------------
  // traverse_graph
  // --------------------------------------------------------------------------
  const TraverseGraphSchema = buildTraverseGraphSchema(maxGraphDepth);
  type TraverseGraphParams = Static<typeof TraverseGraphSchema>;

  const traverseGraphTool: AnyAgentTool = {
    name: "traverse_graph",
    label: "Traverse Graph",
    description:
      "Traverse the Zettelkasten link graph starting from a note, following outgoing " +
      "wikilinks and frontmatter links. Returns all reachable notes up to the given depth.",
    parameters: TraverseGraphSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as TraverseGraphParams;
      const depth = params.depth ?? 2;
      const store = storeFactory();
      const reachable = await store.traverseGraph(params.start_node, depth, maxGraphDepth);
      return jsonResult({ nodes: reachable.map(formatNote) });
    },
  };

  // --------------------------------------------------------------------------
  // read_note
  // --------------------------------------------------------------------------
  const readNoteTool: AnyAgentTool = {
    name: "read_note",
    label: "Read Note",
    description:
      "Read the full content and YAML metadata of a specific Zettelkasten note. " +
      "Accepts a note ID or exact title.",
    parameters: NoteIdSchema,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as NoteIdParams;
      const store = storeFactory();
      const note = await store.resolve(params.note_id);
      if (!note) {
        return jsonResult({ error: `Note not found: ${params.note_id}` });
      }
      return jsonResult({ note: formatNote(note) });
    },
  };

  return [searchNotesTool, getBacklinksTool, traverseGraphTool, readNoteTool];
}
