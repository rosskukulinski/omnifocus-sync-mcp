#!/usr/bin/env node
// Small diagnostic CLI for testing against a live Omni Sync Server account.
// Usage: OMNIFOCUS_SYNC_USERNAME=... OMNIFOCUS_SYNC_PASSWORD=... tsx src/cli.ts <cmd>
//   sync                 show database counts
//   list [filter]        list tasks (remaining|available|flagged|inbox|due_soon|all)
//   projects             list projects
//   add "name"           add an inbox task
//   complete <id>        complete a task
import { loadConfig } from "./config.js";
import { OmniFocusService } from "./ofocus/service.js";
import { queryTasks, summarizeTask, TaskFilter } from "./ofocus/query.js";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const service = new OmniFocusService(loadConfig());

  switch (cmd) {
    case "sync": {
      const { db } = await service.refresh();
      console.log(
        JSON.stringify(
          {
            tasks: db.tasks.size,
            projects: [...db.tasks.values()].filter((t) => t.isProject).length,
            folders: db.folders.size,
            tags: db.tags.size,
            encrypted: service.encrypted,
          },
          null,
          2,
        ),
      );
      break;
    }
    case "list": {
      const tasks = await service.tasks();
      const results = queryTasks(tasks, { filter: (rest[0] as TaskFilter) ?? "remaining", limit: 100 });
      console.log(JSON.stringify(results.map(summarizeTask), null, 2));
      break;
    }
    case "projects": {
      const db = await service.db();
      const projects = (await service.projects()).map((p) => ({
        id: p.id,
        name: p.name,
        folder: db.folderPath(p.projectFolderId),
        status: p.projectStatus ?? "active",
      }));
      console.log(JSON.stringify(projects, null, 2));
      break;
    }
    case "add": {
      const { id } = await service.addTask({ name: rest.join(" ") });
      console.log(`Added task ${id}`);
      break;
    }
    case "complete": {
      await service.completeTask(rest[0]);
      console.log(`Completed ${rest[0]}`);
      break;
    }
    case "delete": {
      await service.deleteTask(rest[0]);
      console.log(`Deleted ${rest[0]}`);
      break;
    }
    default:
      console.error("Unknown command. Try: sync | list | projects | add | complete | delete");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
