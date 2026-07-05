import crypto from "node:crypto";
import plist from "plist";
import { createId } from "../crypto/index.js";

const NS = "http://www.omnigroup.com/namespace/OmniFocus/v2";
const APP_ID = "com.omnigroup.OmniFocus4";
const APP_VERSION = "185.9.1";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** UTC timestamp with milliseconds and Z, for added/modified/completed. */
export function utcIso(d: Date = new Date()): string {
  return d.toISOString().replace(/(\.\d{3})\d*Z$/, "$1Z");
}

/** Floating local wall-clock time (no zone), for due/defer/planned. */
export function floatingLocal(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

function wrap(elements: string[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<omnifocus xmlns="${NS}" app-id="${APP_ID}" app-version="${APP_VERSION}">\n` +
    elements.map((e) => "  " + e).join("\n") +
    "\n</omnifocus>\n"
  );
}

/** A rank near the top of the signed-32-bit range, where new inbox items cluster. */
function newRank(): number {
  return crypto.randomInt(2147480000, 2147483640);
}

export interface AddTaskInput {
  name: string;
  note?: string;
  flagged?: boolean;
  due?: Date;
  defer?: Date;
  /** Parent project or task id. If omitted, the task goes to the inbox. */
  parentId?: string;
  /** Primary tag id. */
  tagId?: string;
  estimatedMinutes?: number;
}

/** Build a create transaction for a single task. Returns the xml and new id. */
export function buildAddTask(input: AddTaskInput): { xml: string; id: string } {
  const id = createId();
  const now = utcIso();
  const lines: string[] = [`<task id="${id}">`];
  lines.push("  <project/>"); // explicitly not a project
  if (input.parentId) {
    lines.push(`  <task idref="${input.parentId}"/>`);
  } else {
    lines.push("  <inbox>true</inbox>");
    lines.push("  <task/>");
  }
  lines.push(`  <added>${now}</added>`);
  lines.push(`  <name>${esc(input.name)}</name>`);
  if (input.note != null && input.note !== "") lines.push(`  <note>${esc(input.note)}</note>`);
  if (input.flagged) lines.push("  <flagged>true</flagged>");
  if (input.due) lines.push(`  <due>${floatingLocal(input.due)}</due>`);
  if (input.defer) lines.push(`  <start>${floatingLocal(input.defer)}</start>`);
  if (input.tagId) lines.push(`  <context idref="${input.tagId}"/>`);
  if (input.estimatedMinutes != null)
    lines.push(`  <estimated-minutes>${input.estimatedMinutes}</estimated-minutes>`);
  lines.push(`  <rank>${newRank()}</rank>`);
  lines.push("  <order>sequential</order>");
  lines.push("</task>");
  return { xml: wrap([lines.join("\n  ")]), id };
}

export interface UpdateTaskFields {
  name?: string;
  note?: string | null;
  flagged?: boolean;
  due?: Date | null;
  defer?: Date | null;
  completed?: Date | null;
  estimatedMinutes?: number | null;
  /** Echo the object's existing <added> so a partial update doesn't clobber it. */
  added?: string | null;
}

/** Build an op="update" transaction. Only the provided fields change. */
export function buildUpdateTask(id: string, fields: UpdateTaskFields): string {
  const lines: string[] = [`<task id="${id}" op="update">`];
  if (fields.added) lines.push(`  <added>${esc(fields.added)}</added>`);
  lines.push(`  <modified>${utcIso()}</modified>`);
  if (fields.name != null) lines.push(`  <name>${esc(fields.name)}</name>`);
  if (fields.note !== undefined)
    lines.push(fields.note ? `  <note>${esc(fields.note)}</note>` : "  <note/>");
  if (fields.flagged !== undefined)
    lines.push(`  <flagged>${fields.flagged ? "true" : "false"}</flagged>`);
  if (fields.due !== undefined)
    lines.push(fields.due ? `  <due>${floatingLocal(fields.due)}</due>` : "  <due/>");
  if (fields.defer !== undefined)
    lines.push(fields.defer ? `  <start>${floatingLocal(fields.defer)}</start>` : "  <start/>");
  if (fields.completed !== undefined)
    lines.push(fields.completed ? `  <completed>${utcIso(fields.completed)}</completed>` : "  <completed/>");
  if (fields.estimatedMinutes !== undefined)
    lines.push(
      fields.estimatedMinutes != null
        ? `  <estimated-minutes>${fields.estimatedMinutes}</estimated-minutes>`
        : "  <estimated-minutes/>",
    );
  lines.push("</task>");
  return wrap([lines.join("\n  ")]);
}

export interface ClientInfo {
  clientId: string;
  hostId: string;
  name: string;
  registrationDate: Date;
  lastSyncDate: Date;
  tailIdentifiers: string[];
}

/** Build a `.client` registration plist. */
export function buildClientPlist(info: ClientInfo): string {
  const dict = {
    ApplicationMarketingVersion: "4.8.8",
    CurrentFrameworkVersion: "2",
    OFMSyncClientModelVersion: "6.0.18",
    OFMSyncClientSupportedCapabilities: ["delta_transactions"],
    XMLSyncClientSupportedCapabilities: [
      "stable_repeats",
      "external_attachments",
      "floating_time_zones",
      "unknown_element_import",
      "versioned_perspectives",
      "delta_transactions",
      "active_object_hidden_dates",
    ],
    bundleIdentifier: APP_ID,
    bundleVersion: APP_VERSION,
    clientIdentifier: info.clientId,
    hostID: info.hostId,
    lastSyncDate: info.lastSyncDate,
    name: info.name,
    registrationDate: info.registrationDate,
    tailIdentifiers: info.tailIdentifiers,
  };
  return plist.build(dict as unknown as plist.PlistValue);
}
