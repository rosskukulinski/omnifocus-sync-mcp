#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { OmniFocusService } from "./ofocus/service.js";
import { queryTasks, summarizeTask, TaskFilter } from "./ofocus/query.js";

function jsonResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }],
    isError: true,
  };
}

function parseDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${s}`);
  return d;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new OmniFocusService(config);

  const server = new McpServer({ name: "omnifocus-sync-mcp", version: "0.1.0" });

  server.registerTool(
    "of_sync",
    {
      title: "Sync OmniFocus",
      description:
        "Reload the OmniFocus database from the Omni Sync Server. Returns counts of tasks, projects, and tags.",
      inputSchema: {},
    },
    async () => {
      try {
        const { db } = await service.refresh();
        return jsonResult({
          tasks: db.tasks.size,
          projects: [...db.tasks.values()].filter((t) => t.isProject).length,
          folders: db.folders.size,
          tags: db.tags.size,
          encrypted: service.encrypted,
          readOnly: service.readOnly,
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "of_list_tasks",
    {
      title: "List OmniFocus tasks",
      description:
        "List tasks with optional filtering. filter: remaining (default), available, flagged, inbox, due_soon, all.",
      inputSchema: {
        filter: z
          .enum(["remaining", "available", "flagged", "inbox", "due_soon", "all"])
          .optional(),
        project: z.string().optional().describe("Filter to a project by name"),
        tag: z.string().optional().describe("Filter to a tag by name"),
        search: z.string().optional().describe("Substring match on name/note"),
        includeCompleted: z.boolean().optional(),
        dueWithinDays: z.number().optional().describe("Window for the due_soon filter (default 7)"),
        limit: z.number().optional().describe("Max results (default 50)"),
      },
    },
    async (args) => {
      try {
        const tasks = await service.tasks();
        const results = queryTasks(tasks, {
          filter: args.filter as TaskFilter | undefined,
          project: args.project,
          tag: args.tag,
          search: args.search,
          includeCompleted: args.includeCompleted,
          dueWithinDays: args.dueWithinDays,
          limit: args.limit ?? 50,
        });
        return jsonResult({ count: results.length, tasks: results.map(summarizeTask) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "of_get_task",
    {
      title: "Get an OmniFocus task",
      description: "Get a single task by its id, with full detail.",
      inputSchema: { id: z.string() },
    },
    async ({ id }) => {
      try {
        const db = await service.db();
        const t = db.tasks.get(id);
        if (!t) return errorResult(new Error(`No task with id ${id}`));
        return jsonResult(summarizeTask(db.view(t)));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "of_list_projects",
    {
      title: "List OmniFocus projects",
      description: "List all projects with their folder path and status.",
      inputSchema: { includeDropped: z.boolean().optional() },
    },
    async ({ includeDropped }) => {
      try {
        const db = await service.db();
        const projects = (await service.projects())
          .filter((p) => includeDropped || p.status !== "dropped")
          .map((p) => ({
            id: p.id,
            name: p.name,
            folder: db.folderPath(p.projectFolderId),
            status: p.projectStatus ?? "active",
            flagged: p.flagged || undefined,
            due: p.due ?? undefined,
          }));
        return jsonResult({ count: projects.length, projects });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "of_add_task",
    {
      title: "Add an OmniFocus task",
      description:
        "Create a task. Without a project it goes to the inbox. Dates accept ISO 8601 strings.",
      inputSchema: {
        name: z.string(),
        note: z.string().optional(),
        project: z.string().optional().describe("Project name or id; omit for inbox"),
        tag: z.string().optional().describe("Primary tag name or id"),
        due: z.string().optional().describe("Due date (ISO 8601)"),
        defer: z.string().optional().describe("Defer/start date (ISO 8601)"),
        flagged: z.boolean().optional(),
        estimatedMinutes: z.number().optional(),
      },
    },
    async (args) => {
      try {
        const { id } = await service.addTask({
          name: args.name,
          note: args.note,
          projectNameOrId: args.project,
          tagNameOrId: args.tag,
          due: parseDate(args.due),
          defer: parseDate(args.defer),
          flagged: args.flagged,
          estimatedMinutes: args.estimatedMinutes,
        });
        return jsonResult({ ok: true, id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "of_complete_task",
    {
      title: "Complete an OmniFocus task",
      description: "Mark a task complete (optionally at a specific ISO 8601 time).",
      inputSchema: { id: z.string(), when: z.string().optional() },
    },
    async ({ id, when }) => {
      try {
        await service.completeTask(id, parseDate(when) ?? new Date());
        return jsonResult({ ok: true, id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "of_edit_task",
    {
      title: "Edit an OmniFocus task",
      description:
        "Edit fields of a task. Use clearDue/clearDefer to remove a date. Only provided fields change.",
      inputSchema: {
        id: z.string(),
        name: z.string().optional(),
        note: z.string().optional(),
        flagged: z.boolean().optional(),
        due: z.string().optional().describe("New due date (ISO 8601)"),
        defer: z.string().optional().describe("New defer date (ISO 8601)"),
        clearDue: z.boolean().optional(),
        clearDefer: z.boolean().optional(),
        estimatedMinutes: z.number().optional(),
      },
    },
    async (args) => {
      try {
        await service.editTask(args.id, {
          name: args.name,
          note: args.note,
          flagged: args.flagged,
          due: args.clearDue ? null : parseDate(args.due),
          defer: args.clearDefer ? null : parseDate(args.defer),
          estimatedMinutes: args.estimatedMinutes,
        });
        return jsonResult({ ok: true, id: args.id });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the JSON-RPC channel; all logging must go to stderr.
  console.error(
    `omnifocus-sync-mcp running (account: ${config.username}, read-only: ${config.readOnly})`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
