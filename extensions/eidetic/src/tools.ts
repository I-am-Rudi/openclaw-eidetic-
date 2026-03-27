/**
 * Eidetic plugin tools – Phase 2: Zettelkasten Skill Development.
 *
 * Provides four tools the Hippocampus (Tiny LLM) calls via function-calling:
 *   search_notes(query)                    – keyword search across all notes
 *   get_backlinks(note_id)                 – reverse-link lookup
 *   traverse_graph(start_node, depth)      – BFS link traversal
 *   read_note(filename_or_id)              – full note content + metadata
 */

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
    description:
      "Search the Zettelkasten knowledge base for notes relevant to a query. " +
      "Returns a ranked list of notes with excerpt and metadata.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query (keywords or a short phrase).",
        },
        maxResults: {
          type: "number",
          description: "Maximum number of notes to return (default: 8).",
        },
      },
      required: ["query"],
    },
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const query = typeof p.query === "string" ? p.query : "";
      const maxResults = typeof p.maxResults === "number" ? p.maxResults : 8;
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
    description:
      "Find all Zettelkasten notes that link to the given note. " +
      "Accepts a note ID or an exact title. Returns a list of linking notes.",
    parameters: {
      type: "object",
      properties: {
        note_id: {
          type: "string",
          description: "Note ID (UUID) or exact title.",
        },
      },
      required: ["note_id"],
    },
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const noteId = typeof p.note_id === "string" ? p.note_id : "";
      const store = storeFactory();
      const backlinks = await store.backlinks(noteId);
      return jsonResult({ backlinks: backlinks.map(formatNote) });
    },
  };

  // --------------------------------------------------------------------------
  // traverse_graph
  // --------------------------------------------------------------------------
  const traverseGraphTool: AnyAgentTool = {
    name: "traverse_graph",
    description:
      "Traverse the Zettelkasten link graph starting from a note, following outgoing " +
      "wikilinks and frontmatter links. Returns all reachable notes up to the given depth.",
    parameters: {
      type: "object",
      properties: {
        start_node: {
          type: "string",
          description: "Note ID (UUID) or exact title to start from.",
        },
        depth: {
          type: "number",
          description: `Traversal depth (1–${maxGraphDepth}, default: 2).`,
        },
      },
      required: ["start_node"],
    },
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const startNode = typeof p.start_node === "string" ? p.start_node : "";
      const depth = typeof p.depth === "number" ? p.depth : 2;
      const store = storeFactory();
      const reachable = await store.traverseGraph(startNode, depth, maxGraphDepth);
      return jsonResult({ nodes: reachable.map(formatNote) });
    },
  };

  // --------------------------------------------------------------------------
  // read_note
  // --------------------------------------------------------------------------
  const readNoteTool: AnyAgentTool = {
    name: "read_note",
    description:
      "Read the full content and YAML metadata of a specific Zettelkasten note. " +
      "Accepts a note ID, exact title.",
    parameters: {
      type: "object",
      properties: {
        note_id: {
          type: "string",
          description: "Note ID (UUID) or exact title.",
        },
      },
      required: ["note_id"],
    },
    execute: async (_toolCallId, params) => {
      const p = params as Record<string, unknown>;
      const noteId = typeof p.note_id === "string" ? p.note_id : "";
      const store = storeFactory();
      const note = await store.resolve(noteId);
      if (!note) {
        return jsonResult({ error: `Note not found: ${noteId}` });
      }
      return jsonResult({ note: formatNote(note) });
    },
  };

  return [searchNotesTool, getBacklinksTool, traverseGraphTool, readNoteTool];
}
