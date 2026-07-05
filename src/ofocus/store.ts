import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { WebDavClient } from "../webdav/client.js";
import {
  createId,
  decryptFile,
  DocumentKey,
  encryptFile,
  parseEncryptionMetadata,
} from "../crypto/index.js";
import { Database } from "./database.js";

const ENCRYPTED_METADATA = "encrypted";
const TXN_RE = /^(\d{14})=(.+)\.zip$/;

export interface TransactionFile {
  name: string;
  timestamp: string; // 14-digit GMT
  parents: string[];
  tail: string;
  isBaseline: boolean;
}

export interface StoreListing {
  transactions: TransactionFile[];
  clientFiles: string[];
  encrypted: boolean;
}

function parseTxnName(name: string): TransactionFile | null {
  const m = TXN_RE.exec(name);
  if (!m) return null;
  const ids = m[2].split("+");
  const tail = ids[ids.length - 1];
  const parents = ids.slice(0, -1);
  return {
    name,
    timestamp: m[1],
    parents,
    tail,
    isBaseline: m[1] === "00000000000000",
  };
}

export function utcStamp(d: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/**
 * A live OmniFocus sync store on a WebDAV server. Handles listing, decryption,
 * state reconstruction, and writing new transactions.
 */
export class OmniFocusStore {
  private docKey: DocumentKey | null = null;

  constructor(
    private readonly dav: WebDavClient,
    /** URL of the `.ofocus` collection, with trailing slash. */
    private readonly ofocusUrl: string,
  ) {}

  private childUrl(name: string): string {
    return this.ofocusUrl.replace(/\/+$/, "") + "/" + name;
  }

  /** Load and unlock the encryption metadata with a passphrase, if present. */
  async unlock(passphrase: string): Promise<void> {
    const url = this.childUrl(ENCRYPTED_METADATA);
    if (!(await this.dav.exists(url))) {
      throw new Error("Store is not encrypted (no `encrypted` metadata file)");
    }
    const meta = parseEncryptionMetadata(await this.dav.get(url));
    this.docKey = DocumentKey.fromMetadata(meta, passphrase);
  }

  get isEncrypted(): boolean {
    return this.docKey != null;
  }

  async list(): Promise<StoreListing> {
    const entries = await this.dav.propfind(this.ofocusUrl);
    const transactions: TransactionFile[] = [];
    const clientFiles: string[] = [];
    let encrypted = false;
    for (const e of entries) {
      if (e.isCollection) continue;
      if (e.name === ENCRYPTED_METADATA) {
        encrypted = true;
        continue;
      }
      if (e.name.endsWith(".client")) {
        clientFiles.push(e.name);
        continue;
      }
      const txn = parseTxnName(e.name);
      if (txn) transactions.push(txn);
    }
    // Chronological order; baseline (00000000000000) naturally sorts first.
    transactions.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { transactions, clientFiles, encrypted };
  }

  /** Fetch a transaction file and return its decrypted contents.xml text. */
  async readContents(name: string): Promise<string> {
    let bytes = await this.dav.get(this.childUrl(name));
    if (this.docKey) bytes = decryptFile(this.docKey, name, bytes);
    const files = unzipSync(new Uint8Array(bytes));
    const entry = files["contents.xml"];
    if (!entry) throw new Error(`No contents.xml in ${name}`);
    return strFromU8(entry);
  }

  /** Reconstruct the full database by replaying all transactions in order. */
  async loadDatabase(): Promise<{ db: Database; listing: StoreListing; headTail: string | null }> {
    const listing = await this.list();
    const db = new Database();
    for (const txn of listing.transactions) {
      db.applyTransaction(await this.readContents(txn.name));
    }
    const headTail = this.computeHeadTail(listing.transactions);
    return { db, listing, headTail };
  }

  /** The current head tail id = a tail that no other transaction lists as a parent. */
  computeHeadTail(transactions: TransactionFile[]): string | null {
    if (transactions.length === 0) return null;
    const parents = new Set<string>();
    for (const t of transactions) for (const p of t.parents) parents.add(p);
    const heads = transactions.filter((t) => !parents.has(t.tail));
    const pool = heads.length > 0 ? heads : transactions;
    // Prefer the newest by timestamp/name.
    pool.sort((a, b) => (a.name < b.name ? 1 : -1));
    return pool[0].tail;
  }

  /**
   * Write a new transaction containing the given contents.xml, descending from
   * `parents` (usually the current head tail). Returns the new file name + tail.
   */
  async writeTransaction(
    contentsXml: string,
    parents: string[],
  ): Promise<{ name: string; tail: string }> {
    const tail = createId();
    const chain = [...parents, tail].join("+");
    const name = `${utcStamp()}=${chain}.zip`;
    const zip = zipSync({ "contents.xml": strToU8(contentsXml) }, { level: 6 });
    let payload: Uint8Array = Buffer.from(zip);
    if (this.docKey) payload = encryptFile(this.docKey, name, Buffer.from(payload));
    await this.dav.put(this.childUrl(name), payload, "application/octet-stream");
    return { name, tail };
  }

  /** Write (or refresh) a `.client` registration file. */
  async writeClientFile(clientId: string, plistXml: string): Promise<string> {
    const name = `${utcStamp()}=${clientId}.client`;
    let payload: Uint8Array = Buffer.from(plistXml, "utf8");
    if (this.docKey) payload = encryptFile(this.docKey, name, Buffer.from(plistXml, "utf8"));
    await this.dav.put(this.childUrl(name), payload, "application/octet-stream");
    return name;
  }

  async ensureExists(): Promise<void> {
    if (!(await this.dav.exists(this.ofocusUrl))) {
      await this.dav.mkcol(this.ofocusUrl);
    }
  }
}
