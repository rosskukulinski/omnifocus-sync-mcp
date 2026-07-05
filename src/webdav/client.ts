import { XMLParser } from "fast-xml-parser";
import { buildDigestAuth, parseDigestChallenge } from "./digest.js";

export interface DavEntry {
  /** Decoded href path, e.g. "/user/OmniFocus.ofocus/00000000000000=a+b.zip". */
  href: string;
  /** Just the final path component (file name). */
  name: string;
  isCollection: boolean;
  contentLength?: number;
}

export interface WebDavOptions {
  baseUrl: string;
  username: string;
  password: string;
  userAgent?: string;
  maxRedirects?: number;
}

/**
 * Minimal WebDAV client for Omni Sync Server: HTTP Digest auth, transparent
 * shard-redirect following (sync.omnigroup.com -> syncN.omnigroup.com), and the
 * verbs OmniFocus sync needs.
 */
export class WebDavClient {
  private readonly username: string;
  private readonly password: string;
  private readonly userAgent: string;
  private readonly maxRedirects: number;
  private readonly challenges = new Map<string, ReturnType<typeof parseDigestChallenge>>();
  private readonly nc = new Map<string, number>();
  private readonly xml = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    parseTagValue: false,
  });

  constructor(opts: WebDavOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.userAgent = opts.userAgent ?? "omnifocus-sync-mcp/0.1 (WebDAV)";
    this.maxRedirects = opts.maxRedirects ?? 5;
  }

  private nextNc(origin: string): number {
    const n = (this.nc.get(origin) ?? 0) + 1;
    this.nc.set(origin, n);
    return n;
  }

  private authHeader(method: string, url: URL): string | undefined {
    const challenge = this.challenges.get(url.origin);
    if (!challenge) return undefined;
    return buildDigestAuth({
      challenge,
      method,
      uri: url.pathname + url.search,
      username: this.username,
      password: this.password,
      nc: this.nextNc(url.origin),
    });
  }

  /** Perform a request, handling digest auth and redirects. Returns the final response + body. */
  async request(
    method: string,
    rawUrl: string,
    init: { headers?: Record<string, string>; body?: Uint8Array | string } = {},
  ): Promise<{ status: number; headers: Headers; body: Buffer; url: string }> {
    let url = new URL(rawUrl);
    let redirects = 0;
    let triedAuth = false;

    while (true) {
      const headers: Record<string, string> = {
        "User-Agent": this.userAgent,
        ...init.headers,
      };
      const auth = this.authHeader(method, url);
      if (auth) headers["Authorization"] = auth;

      const res = await fetch(url, {
        method,
        headers,
        body: init.body as BodyInit | undefined,
        redirect: "manual",
      });
      const body = Buffer.from(await res.arrayBuffer());

      // Follow redirects (shard assignment).
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`Redirect ${res.status} without Location`);
        if (redirects++ >= this.maxRedirects) throw new Error("Too many redirects");
        url = new URL(loc, url);
        triedAuth = false; // new origin needs its own challenge
        continue;
      }

      // Handle digest auth challenge.
      if (res.status === 401) {
        const wwwAuth = res.headers.get("www-authenticate");
        const challenge = wwwAuth ? parseDigestChallenge(wwwAuth) : null;
        if (challenge && !triedAuth) {
          this.challenges.set(url.origin, challenge);
          this.nc.set(url.origin, 0);
          triedAuth = true;
          continue;
        }
        throw new Error(`Authentication failed (401) for ${method} ${url.pathname}`);
      }

      return { status: res.status, headers: res.headers, body, url: url.toString() };
    }
  }

  private ensureOk(r: { status: number }, method: string, url: string, okStatuses: number[]): void {
    if (!okStatuses.includes(r.status)) {
      throw new Error(`${method} ${url} failed: HTTP ${r.status}`);
    }
  }

  /** List the immediate children of a collection (Depth: 1). */
  async propfind(url: string): Promise<DavEntry[]> {
    const r = await this.request("PROPFIND", url, {
      headers: { Depth: "1", "Content-Type": "application/xml" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        '<D:propfind xmlns:D="DAV:"><D:prop>' +
        "<D:resourcetype/><D:getcontentlength/></D:prop></D:propfind>",
    });
    this.ensureOk(r, "PROPFIND", url, [207]);
    return this.parseMultistatus(r.body.toString("utf8"), url);
  }

  private parseMultistatus(xml: string, requestUrl: string): DavEntry[] {
    const doc = this.xml.parse(xml);
    const ms = doc.multistatus ?? doc["D:multistatus"];
    if (!ms) return [];
    const responses = Array.isArray(ms.response) ? ms.response : ms.response ? [ms.response] : [];
    const selfPath = new URL(requestUrl).pathname.replace(/\/+$/, "");
    const entries: DavEntry[] = [];
    for (const resp of responses) {
      const hrefRaw = typeof resp.href === "string" ? resp.href : resp.href?.["#text"];
      if (!hrefRaw) continue;
      const href = decodeURIComponent(hrefRaw);
      const propstat = Array.isArray(resp.propstat) ? resp.propstat[0] : resp.propstat;
      const prop = propstat?.prop ?? {};
      const isCollection = prop.resourcetype != null && "collection" in (prop.resourcetype ?? {});
      const lenRaw = prop.getcontentlength;
      const contentLength = lenRaw != null ? Number(lenRaw) : undefined;
      const path = href.replace(/\/+$/, "");
      // Skip the collection itself.
      if (path === selfPath) continue;
      const name = path.split("/").pop() ?? "";
      entries.push({ href, name, isCollection, contentLength });
    }
    return entries;
  }

  async get(url: string): Promise<Buffer> {
    const r = await this.request("GET", url);
    this.ensureOk(r, "GET", url, [200]);
    return r.body;
  }

  async exists(url: string): Promise<boolean> {
    const r = await this.request("PROPFIND", url, { headers: { Depth: "0" } });
    if (r.status === 207 || r.status === 200) return true;
    if (r.status === 404) return false;
    throw new Error(`PROPFIND ${url} failed: HTTP ${r.status}`);
  }

  async put(url: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    const r = await this.request("PUT", url, { headers: { "Content-Type": contentType }, body });
    this.ensureOk(r, "PUT", url, [200, 201, 204]);
  }

  async mkcol(url: string): Promise<void> {
    const r = await this.request("MKCOL", url);
    this.ensureOk(r, "MKCOL", url, [200, 201]);
  }

  async delete(url: string): Promise<void> {
    const r = await this.request("DELETE", url);
    this.ensureOk(r, "DELETE", url, [200, 202, 204, 404]);
  }
}
