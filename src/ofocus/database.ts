import { XMLParser } from "fast-xml-parser";
import { newTask, OFFolder, OFTag, OFTask, TaskView } from "./model.js";

const TOP_LEVEL_OBJECTS = [
  "task",
  "context",
  "folder",
  "task-to-tag",
  "setting",
  "perspective",
  "attachment",
];

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  isArray: (_name, jpath) => TOP_LEVEL_OBJECTS.map((t) => `omnifocus.${t}`).includes(jpath),
});

/** Read the text content of a parsed child element (string or {#text}). */
function text(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && "#text" in (v as object)) {
    const t = (v as Record<string, unknown>)["#text"];
    return t == null ? "" : String(t);
  }
  // Present but empty (e.g. self-closing <due/>): treat as cleared.
  return "";
}

function attr(v: unknown, name: string): string | null {
  if (v && typeof v === "object") {
    const a = (v as Record<string, unknown>)[`@_${name}`];
    return a == null ? null : String(a);
  }
  return null;
}

function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function toBool(s: string | null): boolean | null {
  if (s == null) return null;
  return s === "true";
}

function toNum(s: string | null): number | null {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/** Empty string => cleared (null); otherwise the value. */
function orNull(s: string | null): string | null {
  return s == null || s === "" ? null : s;
}

/**
 * A reconstructed OmniFocus database. Apply transactions in order, then read.
 */
export class Database {
  readonly tasks = new Map<string, OFTask>();
  readonly folders = new Map<string, OFFolder>();
  readonly tags = new Map<string, OFTag>();
  readonly settings = new Map<string, string>();
  /** join id -> {taskId, tagId} */
  private readonly tagJoins = new Map<string, { taskId: string; tagId: string }>();

  applyTransaction(contentsXml: string): void {
    const doc = parser.parse(contentsXml);
    const root = doc.omnifocus;
    if (!root) return;

    for (const el of (root.task as Record<string, unknown>[]) ?? []) this.applyTask(el);
    for (const el of (root.folder as Record<string, unknown>[]) ?? []) this.applyFolder(el);
    for (const el of (root.context as Record<string, unknown>[]) ?? []) this.applyContext(el);
    for (const el of (root["task-to-tag"] as Record<string, unknown>[]) ?? [])
      this.applyTaskToTag(el);
    for (const el of (root.setting as Record<string, unknown>[]) ?? []) this.applySetting(el);
    // perspectives, attachments: parsed but not modeled in v1.
  }

  private opFor(el: Record<string, unknown>): "create" | "update" | "delete" | "reference" {
    const op = attr(el, "op");
    if (op === "update" || op === "delete" || op === "reference") return op;
    return "create";
  }

  private applyTask(el: Record<string, unknown>): void {
    const id = attr(el, "id");
    if (!id) return;
    const op = this.opFor(el);
    if (op === "reference") return;
    if (op === "delete") {
      this.tasks.delete(id);
      return;
    }
    const t = this.tasks.get(id) ?? newTask(id);

    if (has(el, "name")) t.name = text(el.name) ?? "";
    if (has(el, "note")) t.note = orNull(text(el.note));
    if (has(el, "added")) t.added = orNull(text(el.added));
    if (has(el, "modified")) t.modified = orNull(text(el.modified));
    if (has(el, "completed")) t.completed = orNull(text(el.completed));
    if (has(el, "due")) t.due = orNull(text(el.due));
    if (has(el, "start")) t.defer = orNull(text(el.start));
    if (has(el, "planned")) t.planned = orNull(text(el.planned));
    if (has(el, "flagged")) t.flagged = toBool(text(el.flagged)) ?? false;
    if (has(el, "estimated-minutes")) t.estimatedMinutes = toNum(text(el["estimated-minutes"]));
    if (has(el, "order")) t.order = orNull(text(el.order));
    if (has(el, "rank")) t.rank = toNum(text(el.rank));
    if (has(el, "hidden")) t.droppedDate = orNull(text(el.hidden));
    if (has(el, "repetition-rule")) t.repetitionRule = orNull(text(el["repetition-rule"]));
    if (has(el, "inbox")) t.inInbox = toBool(text(el.inbox)) ?? false;
    // Parent task reference: <task idref="..."/> (empty => top level).
    if (has(el, "task")) t.parentId = attr(el.task, "idref");
    // Primary tag/context: <context idref="..."/>.
    if (has(el, "context")) t.primaryTagId = attr(el.context, "idref");
    // Project-ness: non-empty <project> => project.
    if (has(el, "project")) {
      const p = el.project;
      if (p && typeof p === "object") {
        t.isProject = true;
        t.projectFolderId = attr((p as Record<string, unknown>).folder, "idref");
        const status = has(p as Record<string, unknown>, "status")
          ? text((p as Record<string, unknown>).status)
          : t.projectStatus;
        t.projectStatus = orNull(status);
      } else {
        // Empty <project/> means "not a project".
        t.isProject = false;
        t.projectFolderId = null;
        t.projectStatus = null;
      }
    }
    this.tasks.set(id, t);
  }

  private applyFolder(el: Record<string, unknown>): void {
    const id = attr(el, "id");
    if (!id) return;
    const op = this.opFor(el);
    if (op === "reference") return;
    if (op === "delete") {
      this.folders.delete(id);
      return;
    }
    const f: OFFolder = this.folders.get(id) ?? { id, name: "", parentId: null, rank: null, hidden: null };
    if (has(el, "name")) f.name = text(el.name) ?? "";
    if (has(el, "folder")) f.parentId = attr(el.folder, "idref");
    if (has(el, "rank")) f.rank = toNum(text(el.rank));
    if (has(el, "hidden")) f.hidden = orNull(text(el.hidden));
    this.folders.set(id, f);
  }

  private applyContext(el: Record<string, unknown>): void {
    // In OF3+, <context> elements are tags.
    const id = attr(el, "id");
    if (!id) return;
    const op = this.opFor(el);
    if (op === "reference") return;
    if (op === "delete") {
      this.tags.delete(id);
      return;
    }
    const tag: OFTag = this.tags.get(id) ?? { id, name: "", parentId: null, rank: null };
    if (has(el, "name")) tag.name = text(el.name) ?? "";
    if (has(el, "context")) tag.parentId = attr(el.context, "idref");
    if (has(el, "rank")) tag.rank = toNum(text(el.rank));
    this.tags.set(id, tag);
  }

  private applyTaskToTag(el: Record<string, unknown>): void {
    const id = attr(el, "id");
    if (!id) return;
    const op = this.opFor(el);
    if (op === "reference") return;
    if (op === "delete") {
      this.tagJoins.delete(id);
      return;
    }
    const taskId = attr(el.task, "idref");
    const tagId = attr(el.context, "idref");
    if (taskId && tagId) this.tagJoins.set(id, { taskId, tagId });
  }

  private applySetting(el: Record<string, unknown>): void {
    const id = attr(el, "id");
    if (!id) return;
    if (this.opFor(el) === "delete") {
      this.settings.delete(id);
      return;
    }
    if (has(el, "value")) this.settings.set(id, text(el.value) ?? "");
  }

  /** Resolve tag membership onto tasks (from joins + primary context). */
  private tagIdsForTask(taskId: string, primaryTagId: string | null): string[] {
    const ids = new Set<string>();
    if (primaryTagId) ids.add(primaryTagId);
    for (const { taskId: tid, tagId } of this.tagJoins.values()) {
      if (tid === taskId) ids.add(tagId);
    }
    return [...ids];
  }

  folderPath(id: string | null): string | null {
    if (!id) return null;
    const parts: string[] = [];
    let cur = id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const f = this.folders.get(cur);
      if (!f) break;
      parts.unshift(f.name);
      cur = f.parentId ?? "";
    }
    return parts.join(" / ") || null;
  }

  private projectNameFor(t: OFTask): string | null {
    // Walk up to the containing project.
    let cur: OFTask | undefined = t;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.isProject) return cur.name;
      cur = cur.parentId ? this.tasks.get(cur.parentId) : undefined;
    }
    return null;
  }

  view(t: OFTask): TaskView {
    const tagIds = this.tagIdsForTask(t.id, t.primaryTagId);
    const tagNames = tagIds.map((id) => this.tags.get(id)?.name ?? id);
    const status: TaskView["status"] = t.completed
      ? "completed"
      : t.droppedDate || t.projectStatus === "dropped"
        ? "dropped"
        : "active";
    return {
      ...t,
      tagIds,
      tagNames,
      projectName: t.isProject ? t.name : this.projectNameFor(t),
      status,
    };
  }

  allTaskViews(): TaskView[] {
    return [...this.tasks.values()].map((t) => this.view(t));
  }
}
