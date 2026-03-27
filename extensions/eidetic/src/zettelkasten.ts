/**
 * Zettelkasten storage layer.
 *
 * Manages a directory of .md files with YAML frontmatter conforming to the
 * following mandatory schema:
 *
 *   ---
 *   id: <uuid-v4>
 *   title: <string>
 *   tags: [<string>, ...]
 *   links: [<note-id-or-title>, ...]
 *   created: <ISO-8601>
 *   updated: <ISO-8601>
 *   ---
 *
 * Wikilinks of the form [[Title]] in the body are also parsed and treated as
 * bidirectional graph edges.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// ============================================================================
// Types
// ============================================================================

export type ZettelFrontmatter = {
  id: string;
  title: string;
  tags: string[];
  links: string[];
  created: string;
  updated: string;
};

export type ZettelNote = {
  frontmatter: ZettelFrontmatter;
  body: string;
  /** Absolute filesystem path to the .md file. */
  filePath: string;
  /** Wikilinks [[Title]] parsed from the body. */
  wikilinks: string[];
};

export type NoteSearchResult = {
  note: ZettelNote;
  /** Relevance score 0–1 (higher = more relevant). */
  score: number;
  /** Matched excerpt from the body. */
  excerpt: string;
};

// ============================================================================
// YAML frontmatter helpers
// ============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** Parse a minimal YAML frontmatter block (no external deps). */
function parseFrontmatter(raw: string): Partial<ZettelFrontmatter> {
  const result: Partial<ZettelFrontmatter> = {};
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    if (key === "id" || key === "title" || key === "created" || key === "updated") {
      result[key] = val;
    } else if (key === "tags" || key === "links") {
      // Inline array: [a, b, c]  or  multiline is not supported in this lightweight parser
      const stripped = val.replace(/^\[/, "").replace(/\]$/, "");
      result[key] = stripped
        ? stripped
            .split(",")
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
            .filter(Boolean)
        : [];
    }
  }
  return result;
}

/** Render a ZettelFrontmatter object back to a YAML block (no external deps). */
function renderFrontmatter(fm: ZettelFrontmatter): string {
  const tagsStr = `[${fm.tags.map((t) => `"${t}"`).join(", ")}]`;
  const linksStr = `[${fm.links.map((l) => `"${l}"`).join(", ")}]`;
  return [
    "---",
    `id: ${fm.id}`,
    `title: ${fm.title}`,
    `tags: ${tagsStr}`,
    `links: ${linksStr}`,
    `created: ${fm.created}`,
    `updated: ${fm.updated}`,
    "---",
    "",
  ].join("\n");
}

/** Extract [[Title]] wikilinks from a body string. */
function parseWikilinks(body: string): string[] {
  const links: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, "g");
  while ((m = re.exec(body)) !== null) {
    links.push(m[1]!);
  }
  return links;
}

// ============================================================================
// ZettelkastenStore
// ============================================================================

export class ZettelkastenStore {
  private readonly dir: string;
  /** In-memory index: note id → ZettelNote */
  private index: Map<string, ZettelNote> = new Map();
  /** Title (lowercase) → note id */
  private titleIndex: Map<string, string> = new Map();
  private loaded = false;

  constructor(dir: string) {
    this.dir = resolve(dir.replace(/^~/, process.env.HOME ?? "~"));
  }

  // --------------------------------------------------------------------------
  // Initialisation
  // --------------------------------------------------------------------------

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async load(): Promise<void> {
    await this.ensureDir();
    this.index.clear();
    this.titleIndex.clear();
    const files = await readdir(this.dir);
    for (const file of files) {
      if (!file.endsWith(".md")) {
        continue;
      }
      try {
        const note = await this.readFromDisk(join(this.dir, file));
        this.index.set(note.frontmatter.id, note);
        this.titleIndex.set(note.frontmatter.title.toLowerCase(), note.frontmatter.id);
      } catch {
        // Skip malformed notes
      }
    }
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  // --------------------------------------------------------------------------
  // Read helpers
  // --------------------------------------------------------------------------

  private async readFromDisk(filePath: string): Promise<ZettelNote> {
    const raw = await readFile(filePath, "utf-8");
    const m = FRONTMATTER_RE.exec(raw);
    if (!m) {
      throw new Error(`No valid frontmatter in ${filePath}`);
    }
    const partial = parseFrontmatter(m[1] ?? "");
    const body = m[2] ?? "";
    const frontmatter: ZettelFrontmatter = {
      id: partial.id ?? randomUUID(),
      title: partial.title ?? "Untitled",
      tags: partial.tags ?? [],
      links: partial.links ?? [],
      created: partial.created ?? new Date().toISOString(),
      updated: partial.updated ?? new Date().toISOString(),
    };
    return {
      frontmatter,
      body,
      filePath,
      wikilinks: parseWikilinks(body),
    };
  }

  /** Return a snapshot of all loaded notes. */
  async allNotes(): Promise<ZettelNote[]> {
    await this.ensureLoaded();
    return Array.from(this.index.values());
  }

  /** Resolve a note by id or by title (case-insensitive). */
  async resolve(idOrTitle: string): Promise<ZettelNote | undefined> {
    await this.ensureLoaded();
    if (this.index.has(idOrTitle)) {
      return this.index.get(idOrTitle);
    }
    const id = this.titleIndex.get(idOrTitle.toLowerCase());
    return id ? this.index.get(id) : undefined;
  }

  // --------------------------------------------------------------------------
  // search_notes(query)
  // --------------------------------------------------------------------------

  /** Keyword search across title, tags, and body. Returns ranked results. */
  async search(query: string, maxResults = 10): Promise<NoteSearchResult[]> {
    await this.ensureLoaded();
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1);
    const scored: NoteSearchResult[] = [];

    for (const note of this.index.values()) {
      const haystack = [note.frontmatter.title, ...note.frontmatter.tags, note.body]
        .join(" ")
        .toLowerCase();

      let hits = 0;
      let excerpt = "";
      for (const term of terms) {
        const idx = haystack.indexOf(term);
        if (idx !== -1) {
          hits++;
          if (!excerpt) {
            const start = Math.max(0, idx - 40);
            excerpt = "…" + haystack.slice(start, start + 120) + "…";
          }
        }
      }
      if (hits === 0) {
        continue;
      }
      // Title matches score higher
      const titleHits = terms.filter((t) =>
        note.frontmatter.title.toLowerCase().includes(t),
      ).length;
      const score = Math.min(1, (hits * 0.15 + titleHits * 0.35) / terms.length);
      scored.push({ note, score, excerpt });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
  }

  // --------------------------------------------------------------------------
  // get_backlinks(note_id_or_title)
  // --------------------------------------------------------------------------

  /** Return all notes that link to the given note (by id or wikilink title). */
  async backlinks(idOrTitle: string): Promise<ZettelNote[]> {
    await this.ensureLoaded();
    const target = await this.resolve(idOrTitle);
    if (!target) {
      return [];
    }
    const targetTitle = target.frontmatter.title.toLowerCase();
    const targetId = target.frontmatter.id;

    const result: ZettelNote[] = [];
    for (const note of this.index.values()) {
      if (note.frontmatter.id === targetId) {
        continue;
      }
      const linksToTarget =
        note.frontmatter.links.some((l) => l === targetId || l.toLowerCase() === targetTitle) ||
        note.wikilinks.some((w) => w.toLowerCase() === targetTitle);
      if (linksToTarget) {
        result.push(note);
      }
    }
    return result;
  }

  // --------------------------------------------------------------------------
  // traverse_graph(start, depth)
  // --------------------------------------------------------------------------

  /** BFS graph traversal starting from a note, following outgoing links. */
  async traverseGraph(
    startIdOrTitle: string,
    depth: number,
    maxDepth: number,
  ): Promise<ZettelNote[]> {
    await this.ensureLoaded();
    const start = await this.resolve(startIdOrTitle);
    if (!start) {
      return [];
    }

    const visited = new Set<string>();
    const queue: Array<{ note: ZettelNote; d: number }> = [{ note: start, d: 0 }];
    const results: ZettelNote[] = [];
    const effectiveDepth = Math.min(depth, maxDepth);

    while (queue.length > 0) {
      const { note, d } = queue.shift()!;
      if (visited.has(note.frontmatter.id)) {
        continue;
      }
      visited.add(note.frontmatter.id);
      if (d > 0) {
        results.push(note); // exclude the start node itself
      }
      if (d >= effectiveDepth) {
        continue;
      }
      // Follow outgoing edges: frontmatter.links + wikilinks
      const neighbours = [...note.frontmatter.links, ...note.wikilinks];
      for (const ref of neighbours) {
        const neighbour = await this.resolve(ref);
        if (neighbour && !visited.has(neighbour.frontmatter.id)) {
          queue.push({ note: neighbour, d: d + 1 });
        }
      }
    }
    return results;
  }

  // --------------------------------------------------------------------------
  // Write helpers
  // --------------------------------------------------------------------------

  /** Create a new note or overwrite an existing one. Returns the saved note. */
  async upsert(opts: {
    id?: string;
    title: string;
    tags?: string[];
    links?: string[];
    body: string;
  }): Promise<ZettelNote> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const existing = opts.id ? this.index.get(opts.id) : undefined;
    const frontmatter: ZettelFrontmatter = {
      id: opts.id ?? randomUUID(),
      title: opts.title,
      tags: opts.tags ?? [],
      links: opts.links ?? [],
      created: existing?.frontmatter.created ?? now,
      updated: now,
    };
    const slug = opts.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64);
    const filePath = join(this.dir, `${slug}-${frontmatter.id.slice(0, 8)}.md`);
    const content = renderFrontmatter(frontmatter) + opts.body;
    await writeFile(existing?.filePath ?? filePath, content, "utf-8");
    const note: ZettelNote = {
      frontmatter,
      body: opts.body,
      filePath: existing?.filePath ?? filePath,
      wikilinks: parseWikilinks(opts.body),
    };
    this.index.set(frontmatter.id, note);
    this.titleIndex.set(frontmatter.title.toLowerCase(), frontmatter.id);
    return note;
  }
}
