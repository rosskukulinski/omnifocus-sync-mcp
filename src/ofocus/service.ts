import { Config } from "../config.js";
import { WebDavClient } from "../webdav/client.js";
import { Database } from "./database.js";
import { ClientState, loadOrCreateClientState } from "./clientState.js";
import { OmniFocusStore, StoreListing } from "./store.js";
import { TaskView } from "./model.js";
import {
  AddTaskInput,
  buildAddTask,
  buildClientPlist,
  buildDeleteTask,
  buildUpdateTask,
  UpdateTaskFields,
} from "./writer.js";

interface Loaded {
  db: Database;
  listing: StoreListing;
  headTail: string | null;
}

/** High-level OmniFocus operations over the sync store. */
export class OmniFocusService {
  private readonly store: OmniFocusStore;
  private readonly clientState: ClientState;
  private cache: Loaded | null = null;
  private initialized = false;

  constructor(private readonly config: Config) {
    const dav = new WebDavClient({
      baseUrl: config.ofocusUrl,
      username: config.username,
      password: config.password,
    });
    this.store = new OmniFocusStore(dav, config.ofocusUrl);
    this.clientState = loadOrCreateClientState(config.clientStateFile, config.clientName);
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    const listing = await this.store.list();
    if (listing.encrypted) {
      await this.store.unlock(this.config.passphrase);
    }
    this.initialized = true;
  }

  /** Load (or reload) the full database from the server. */
  async refresh(): Promise<Loaded> {
    await this.init();
    this.cache = await this.store.loadDatabase();
    return this.cache;
  }

  private async loaded(): Promise<Loaded> {
    if (!this.cache) return this.refresh();
    return this.cache;
  }

  get readOnly(): boolean {
    return this.config.readOnly;
  }

  get encrypted(): boolean {
    return this.store.isEncrypted;
  }

  // ---- Reads ----

  async tasks(): Promise<TaskView[]> {
    return (await this.loaded()).db.allTaskViews();
  }

  async projects(): Promise<TaskView[]> {
    return (await this.tasks()).filter((t) => t.isProject);
  }

  async db(): Promise<Database> {
    return (await this.loaded()).db;
  }

  private async resolveProjectId(nameOrId: string): Promise<string> {
    const projects = await this.projects();
    const byId = projects.find((p) => p.id === nameOrId);
    if (byId) return byId.id;
    const matches = projects.filter((p) => p.name.toLowerCase() === nameOrId.toLowerCase());
    if (matches.length === 1) return matches[0].id;
    if (matches.length === 0) throw new Error(`No project named "${nameOrId}"`);
    throw new Error(`Ambiguous project name "${nameOrId}" (${matches.length} matches)`);
  }

  private async resolveTagId(nameOrId: string): Promise<string> {
    const db = await this.db();
    if (db.tags.has(nameOrId)) return nameOrId;
    const matches = [...db.tags.values()].filter(
      (t) => t.name.toLowerCase() === nameOrId.toLowerCase(),
    );
    if (matches.length === 1) return matches[0].id;
    if (matches.length === 0) throw new Error(`No tag named "${nameOrId}"`);
    throw new Error(`Ambiguous tag name "${nameOrId}"`);
  }

  // ---- Writes ----

  private assertWritable(): void {
    if (this.config.readOnly) throw new Error("Server is in read-only mode (OMNIFOCUS_READ_ONLY)");
  }

  /** Commit a contents.xml transaction and refresh our client registration. */
  private async commit(contentsXml: string): Promise<void> {
    const loaded = await this.loaded();
    const parents = loaded.headTail ? [loaded.headTail] : [];
    const { tail } = await this.store.writeTransaction(contentsXml, parents);
    // Register/refresh our client file so we're a recognized sync participant.
    const plistXml = buildClientPlist({
      clientId: this.clientState.clientId,
      hostId: this.clientState.hostId,
      name: this.clientState.name,
      registrationDate: new Date(this.clientState.registrationDate),
      lastSyncDate: new Date(),
      tailIdentifiers: [tail],
    });
    await this.store.writeClientFile(this.clientState.clientId, plistXml);
    // Local cache is now stale.
    this.cache = null;
  }

  async addTask(
    input: AddTaskInput & { projectNameOrId?: string; tagNameOrId?: string },
  ): Promise<{ id: string }> {
    this.assertWritable();
    await this.loaded();
    const resolved: AddTaskInput = { ...input };
    if (input.projectNameOrId) resolved.parentId = await this.resolveProjectId(input.projectNameOrId);
    if (input.tagNameOrId) resolved.tagId = await this.resolveTagId(input.tagNameOrId);
    const { xml, id } = buildAddTask(resolved);
    await this.commit(xml);
    return { id };
  }

  async completeTask(id: string, when: Date = new Date()): Promise<void> {
    this.assertWritable();
    const loaded = await this.loaded();
    const task = loaded.db.tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    const xml = buildUpdateTask(id, { completed: when, added: task.added });
    await this.commit(xml);
  }

  async editTask(id: string, fields: UpdateTaskFields): Promise<void> {
    this.assertWritable();
    const loaded = await this.loaded();
    const task = loaded.db.tasks.get(id);
    if (!task) throw new Error(`No task with id ${id}`);
    const xml = buildUpdateTask(id, { ...fields, added: task.added });
    await this.commit(xml);
  }

  async deleteTask(id: string): Promise<void> {
    this.assertWritable();
    const loaded = await this.loaded();
    if (!loaded.db.tasks.get(id)) throw new Error(`No task with id ${id}`);
    await this.commit(buildDeleteTask(id));
  }
}
