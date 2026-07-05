import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createId } from "../crypto/index.js";

export interface ClientState {
  clientId: string;
  hostId: string;
  name: string;
  registrationDate: string; // ISO
}

/**
 * Load a stable client identity from disk, creating one on first run. A stable
 * clientId/hostId is what makes other OmniFocus clients treat this process as a
 * real sync participant (and keeps compaction from orphaning our writes).
 */
export function loadOrCreateClientState(file: string, name: string): ClientState {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as ClientState;
    if (parsed.clientId && parsed.hostId) return parsed;
  } catch {
    // fall through to create
  }
  const state: ClientState = {
    clientId: createId(),
    hostId: crypto.randomUUID().toUpperCase(),
    name,
    registrationDate: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  return state;
}
