/**
 * Tests for the Eidetic hierarchical agentic memory extension.
 *
 * Covers:
 *  - ZettelkastenStore: upsert, search, backlinks, graph traversal
 *  - Tool factories: schema + execute shapes
 *  - extractInsights heuristic
 *  - Hippocampus.buildContextBlock graceful-degradation on network failure
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractInsights } from "./src/consolidation.js";
import { Hippocampus } from "./src/hippocampus.js";
import { createEideticTools } from "./src/tools.js";
import { ZettelkastenStore } from "./src/zettelkasten.js";

// ============================================================================
// ZettelkastenStore tests
// ============================================================================

describe("ZettelkastenStore", () => {
  let tmpDir: string;
  let store: ZettelkastenStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "eidetic-test-"));
    store = new ZettelkastenStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("upserts a note and resolves by title", async () => {
    const note = await store.upsert({
      title: "Hippocampal Memory",
      tags: ["neuroscience", "memory"],
      links: [],
      body: "The hippocampus is responsible for consolidating short-term to long-term memory.",
    });
    expect(note.frontmatter.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(note.frontmatter.title).toBe("Hippocampal Memory");

    const resolved = await store.resolve("Hippocampal Memory");
    expect(resolved?.frontmatter.id).toBe(note.frontmatter.id);
  });

  it("upserts a note and resolves by id", async () => {
    const note = await store.upsert({
      title: "Graph Theory",
      tags: ["math"],
      links: [],
      body: "Graphs consist of nodes and edges.",
    });
    const resolved = await store.resolve(note.frontmatter.id);
    expect(resolved?.frontmatter.title).toBe("Graph Theory");
  });

  it("search returns ranked results for matching terms", async () => {
    await store.upsert({
      title: "Zettelkasten Method",
      tags: ["productivity", "notes"],
      links: [],
      body: "The Zettelkasten method uses atomic notes linked by ideas.",
    });
    await store.upsert({
      title: "Unrelated Topic",
      tags: ["cooking"],
      links: [],
      body: "How to make pasta.",
    });

    const results = await store.search("zettelkasten notes");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.note.frontmatter.title).toBe("Zettelkasten Method");
  });

  it("search returns empty array for non-matching query", async () => {
    await store.upsert({
      title: "Known Topic",
      tags: [],
      links: [],
      body: "Some content here.",
    });
    const results = await store.search("xyzxyzxyz");
    expect(results).toHaveLength(0);
  });

  it("backlinks resolves reverse links by title", async () => {
    const target = await store.upsert({
      title: "Target Note",
      tags: [],
      links: [],
      body: "I am the target.",
    });
    await store.upsert({
      title: "Linker Note",
      tags: [],
      links: [target.frontmatter.id],
      body: "I link to [[Target Note]].",
    });
    const bls = await store.backlinks("Target Note");
    expect(bls.length).toBe(1);
    expect(bls[0]?.frontmatter.title).toBe("Linker Note");
  });

  it("traverseGraph follows links up to max depth", async () => {
    const c = await store.upsert({ title: "C", tags: [], links: [], body: "Leaf" });
    const b = await store.upsert({
      title: "B",
      tags: [],
      links: [c.frontmatter.id],
      body: `[[C]]`,
    });
    const a = await store.upsert({
      title: "A",
      tags: [],
      links: [b.frontmatter.id],
      body: `[[B]]`,
    });
    // Suppress unused var warning
    void a;

    // Traverse from A depth=1: should reach B only
    const depth1 = await store.traverseGraph("A", 1, 3);
    expect(depth1.map((n) => n.frontmatter.title)).toContain("B");
    expect(depth1.map((n) => n.frontmatter.title)).not.toContain("C");

    // Traverse from A depth=2: should reach B and C
    const depth2 = await store.traverseGraph("A", 2, 3);
    const titles = depth2.map((n) => n.frontmatter.title);
    expect(titles).toContain("B");
    expect(titles).toContain("C");
  });

  it("traverseGraph respects maxDepth limit", async () => {
    const c = await store.upsert({ title: "Node C", tags: [], links: [], body: "" });
    const b = await store.upsert({
      title: "Node B",
      tags: [],
      links: [c.frontmatter.id],
      body: "",
    });
    const a = await store.upsert({
      title: "Node A",
      tags: [],
      links: [b.frontmatter.id],
      body: "",
    });
    void a;

    // Even if requested depth=5, maxDepth=1 should only return Node B
    const result = await store.traverseGraph("Node A", 5, 1);
    expect(result.map((n) => n.frontmatter.title)).toContain("Node B");
    expect(result.map((n) => n.frontmatter.title)).not.toContain("Node C");
  });

  it("parses wikilinks from body", async () => {
    const note = await store.upsert({
      title: "Wikilink Test",
      tags: [],
      links: [],
      body: "See [[Graph Theory]] and [[Zettelkasten Method]] for details.",
    });
    expect(note.wikilinks).toContain("Graph Theory");
    expect(note.wikilinks).toContain("Zettelkasten Method");
  });

  it("load re-indexes existing .md files from disk", async () => {
    // Write a note, then create a fresh store instance over the same dir
    const original = await store.upsert({
      title: "Persisted Note",
      tags: ["persist"],
      links: [],
      body: "This should survive a reload.",
    });
    const store2 = new ZettelkastenStore(tmpDir);
    await store2.load();
    const loaded = await store2.resolve(original.frontmatter.id);
    expect(loaded?.frontmatter.title).toBe("Persisted Note");
  });
});

// ============================================================================
// Tool factories
// ============================================================================

describe("createEideticTools", () => {
  let tmpDir: string;
  let storeFactory: () => ZettelkastenStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "eidetic-tools-test-"));
    storeFactory = () => new ZettelkastenStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns exactly 4 tools with correct names", () => {
    const tools = createEideticTools({ storeFactory });
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["get_backlinks", "read_note", "search_notes", "traverse_graph"].sort());
  });

  it("search_notes returns results as JSON", async () => {
    const store = storeFactory();
    await store.upsert({
      title: "Cognitive Science",
      tags: ["science"],
      links: [],
      body: "Cognitive science studies the mind and intelligence.",
    });

    const tools = createEideticTools({ storeFactory });
    const searchTool = tools.find((t) => t.name === "search_notes")!;
    const result = await searchTool.execute("call-1", { query: "cognitive science" });
    const parsed = (result as { details: unknown }).details as Record<string, unknown>;
    expect(Array.isArray(parsed.results) && (parsed.results as unknown[]).length).toBeGreaterThan(
      0,
    );
  });

  it("read_note returns error for unknown note", async () => {
    const tools = createEideticTools({ storeFactory });
    const readTool = tools.find((t) => t.name === "read_note")!;
    const result = await readTool.execute("call-2", { note_id: "nonexistent" });
    const parsed = (result as { details: unknown }).details as Record<string, unknown>;
    expect(String(parsed.error)).toMatch(/not found/i);
  });

  it("get_backlinks returns empty for note with no backlinks", async () => {
    const store = storeFactory();
    await store.upsert({ title: "Lone Note", tags: [], links: [], body: "Standalone." });

    const tools = createEideticTools({ storeFactory });
    const backlinkTool = tools.find((t) => t.name === "get_backlinks")!;
    const result = await backlinkTool.execute("call-3", { note_id: "Lone Note" });
    const parsed = (result as { details: unknown }).details as Record<string, unknown>;
    expect(parsed.backlinks as unknown[]).toHaveLength(0);
  });

  it("traverse_graph returns reachable nodes", async () => {
    const store = storeFactory();
    const child = await store.upsert({ title: "Child", tags: [], links: [], body: "" });
    await store.upsert({
      title: "Root",
      tags: [],
      links: [child.frontmatter.id],
      body: "",
    });

    const tools = createEideticTools({ storeFactory, maxGraphDepth: 3 });
    const traverseTool = tools.find((t) => t.name === "traverse_graph")!;
    const result = await traverseTool.execute("call-4", { start_node: "Root", depth: 1 });
    const parsed = (result as { details: unknown }).details as Record<string, unknown>;
    expect(parsed.nodes as unknown[]).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Child" })]),
    );
  });
});

// ============================================================================
// extractInsights heuristic
// ============================================================================

describe("extractInsights", () => {
  it("extracts assistant turns as insight candidates", () => {
    const messages = [
      { role: "user", content: "What is the Zettelkasten method?" },
      {
        role: "assistant",
        content:
          "The Zettelkasten method is a personal knowledge management system developed by Niklas Luhmann. " +
          "It uses atomic notes that are linked to each other to form a knowledge graph.",
      },
    ];
    const candidates = extractInsights(messages, []);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.body).toContain("Zettelkasten");
  });

  it("skips short assistant messages", () => {
    const messages = [{ role: "assistant", content: "OK." }];
    const candidates = extractInsights(messages, []);
    expect(candidates).toHaveLength(0);
  });

  it("links to existing notes when their title appears in the response", () => {
    const existing = [
      {
        frontmatter: {
          id: "abc123",
          title: "Graph Theory",
          tags: [],
          links: [],
          created: "",
          updated: "",
        },
        body: "",
        filePath: "",
        wikilinks: [],
      },
    ];
    const messages = [
      {
        role: "assistant",
        content:
          "Graph Theory is fundamental to computer science. " +
          "It studies structures consisting of nodes and edges. " +
          "Many algorithms rely on graph traversal techniques.",
      },
    ];
    const candidates = extractInsights(messages, existing);
    expect(candidates[0]?.linkedTitles).toContain("Graph Theory");
  });

  it("deduplicates against existing note titles", () => {
    const existing = [
      {
        frontmatter: {
          id: "xyz",
          title: "The Zettelkasten method is a personal knowledge management system",
          tags: [],
          links: [],
          created: "",
          updated: "",
        },
        body: "",
        filePath: "",
        wikilinks: [],
      },
    ];
    const messages = [
      {
        role: "assistant",
        content:
          "The Zettelkasten method is a personal knowledge management system developed by Luhmann. " +
          "It uses atomic notes linked to form a knowledge graph.",
      },
    ];
    // The candidate title matches the existing note title – should be skipped
    const candidates = extractInsights(messages, existing);
    // The title should NOT be added again
    const titles = candidates.map((c) => c.title);
    expect(titles).not.toContain(
      "The Zettelkasten method is a personal knowledge management system",
    );
  });
});

// ============================================================================
// Hippocampus graceful degradation
// ============================================================================

describe("Hippocampus", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty string when Ollama is unreachable", async () => {
    // Mock fetch to simulate a network error
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const hippo = new Hippocampus({ ollamaBaseUrl: "http://localhost:11434" });
    const ctx = await hippo.buildContextBlock("What is the meaning of life?");
    expect(ctx).toBe("");
  });

  it("returns empty string when Ollama returns non-ok status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const hippo = new Hippocampus({});
    const ctx = await hippo.buildContextBlock("test prompt");
    expect(ctx).toBe("");
  });

  it("returns briefing block when Ollama responds with content", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          message: { content: "BRIEFING:\nSome synthesised context." },
        }),
      }),
    );

    const hippo = new Hippocampus({});
    const ctx = await hippo.buildContextBlock("test prompt");
    expect(ctx).toContain("BRIEFING:");
    expect(ctx).toContain("Eidetic Zettelkasten Context");
  });

  it("respects the timeout and degrades gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        (_url: string, opts: { signal?: AbortSignal }) =>
          new Promise((_res, rej) => {
            opts?.signal?.addEventListener("abort", () => rej(new DOMException("aborted")));
          }),
      ),
    );

    const hippo = new Hippocampus({});
    const ctx = await hippo.buildContextBlock("test prompt", 50); // 50ms timeout
    expect(ctx).toBe("");
  });
});
