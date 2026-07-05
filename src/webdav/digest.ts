import crypto from "node:crypto";

interface Challenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm?: string;
}

/** Parse a `WWW-Authenticate: Digest ...` header value into its parameters. */
export function parseDigestChallenge(header: string): Challenge | null {
  const m = /^Digest\s+(.*)$/is.exec(header.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  // Match key=value where value is quoted or a bare token.
  const re = /(\w+)=(?:"([^"]*)"|([^,\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(m[1])) !== null) {
    params[match[1].toLowerCase()] = match[2] ?? match[3];
  }
  if (!params.realm || !params.nonce) return null;
  return {
    realm: params.realm,
    nonce: params.nonce,
    qop: params.qop,
    opaque: params.opaque,
    algorithm: params.algorithm,
  };
}

function md5(s: string): string {
  return crypto.createHash("md5").update(s, "utf8").digest("hex");
}

/**
 * Build an `Authorization: Digest ...` header for a request. Implements
 * RFC 2617 MD5 with `qop=auth`, which is what Omni Sync Server negotiates.
 */
export function buildDigestAuth(opts: {
  challenge: Challenge;
  method: string;
  uri: string;
  username: string;
  password: string;
  nc: number;
}): string {
  const { challenge, method, uri, username, password } = opts;
  const cnonce = crypto.randomBytes(8).toString("hex");
  const nc = opts.nc.toString(16).padStart(8, "0");

  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  let response: string;
  const qop = challenge.qop?.split(",").map((s) => s.trim()).includes("auth") ? "auth" : undefined;
  if (qop) {
    response = md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${challenge.nonce}:${ha2}`);
  }

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return "Digest " + parts.join(", ");
}
