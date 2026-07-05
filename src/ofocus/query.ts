import { TaskView } from "./model.js";

export type TaskFilter = "remaining" | "available" | "flagged" | "inbox" | "due_soon" | "all";

export interface QueryOptions {
  filter?: TaskFilter;
  project?: string;
  tag?: string;
  search?: string;
  includeCompleted?: boolean;
  includeProjects?: boolean;
  dueWithinDays?: number;
  limit?: number;
}

function parseWhen(s: string | null): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

export function queryTasks(tasks: TaskView[], opts: QueryOptions): TaskView[] {
  const filter = opts.filter ?? "remaining";
  const now = Date.now();
  const dueWindow = (opts.dueWithinDays ?? 7) * 86400_000;

  let result = tasks.filter((t) => {
    if (!opts.includeProjects && t.isProject) return false;
    return true;
  });

  if (!opts.includeCompleted && filter !== "all") {
    result = result.filter((t) => t.status !== "completed");
  }

  switch (filter) {
    case "inbox":
      result = result.filter((t) => t.inInbox);
      break;
    case "flagged":
      result = result.filter((t) => t.flagged && t.status === "active");
      break;
    case "available":
      result = result.filter((t) => {
        if (t.status !== "active") return false;
        const defer = parseWhen(t.defer);
        return defer == null || defer <= now;
      });
      break;
    case "due_soon":
      result = result.filter((t) => {
        if (t.status !== "active") return false;
        const due = parseWhen(t.due);
        return due != null && due - now <= dueWindow;
      });
      break;
    case "remaining":
      result = result.filter((t) => t.status === "active");
      break;
    case "all":
      break;
  }

  if (opts.project) {
    const p = opts.project.toLowerCase();
    result = result.filter((t) => (t.projectName ?? "").toLowerCase() === p);
  }
  if (opts.tag) {
    const tg = opts.tag.toLowerCase();
    result = result.filter((t) => t.tagNames.some((n) => n.toLowerCase() === tg));
  }
  if (opts.search) {
    const q = opts.search.toLowerCase();
    result = result.filter(
      (t) => t.name.toLowerCase().includes(q) || (t.note ?? "").toLowerCase().includes(q),
    );
  }

  // Sort: flagged first, then by due date, then name.
  result.sort((a, b) => {
    if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
    const da = parseWhen(a.due) ?? Infinity;
    const dbb = parseWhen(b.due) ?? Infinity;
    if (da !== dbb) return da - dbb;
    return a.name.localeCompare(b.name);
  });

  if (opts.limit && opts.limit > 0) result = result.slice(0, opts.limit);
  return result;
}

export function summarizeTask(t: TaskView) {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    flagged: t.flagged || undefined,
    project: t.projectName ?? undefined,
    tags: t.tagNames.length ? t.tagNames : undefined,
    due: t.due ?? undefined,
    defer: t.defer ?? undefined,
    completed: t.completed ?? undefined,
    inbox: t.inInbox || undefined,
    note: t.note ?? undefined,
    estimatedMinutes: t.estimatedMinutes ?? undefined,
    isProject: t.isProject || undefined,
    projectStatus: t.isProject ? t.projectStatus ?? undefined : undefined,
  };
}
