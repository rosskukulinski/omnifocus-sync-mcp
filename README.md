# omnifocus-sync-mcp

A headless [MCP](https://modelcontextprotocol.io) server that reads **and writes**
OmniFocus data by talking **directly to the Omni Sync Server** over WebDAV — no Mac,
no running OmniFocus app. It implements OmniFocus's client-side end-to-end encryption
in TypeScript, so it can run anywhere Node runs (a Linux NAS, a container, a cloud box).

Every other OmniFocus MCP server automates the local macOS app via AppleScript/JXA.
This one speaks the cloud sync protocol instead, which is what lets it run headless.

> ⚠️ **Alpha / use at your own risk.** This talks to your real task database. The
> encryption and parsing are covered by an offline test suite, but the *write* path
> has not been battle-tested against every OmniFocus version. **Test against a
> throwaway Omni account first, and keep a backup** (in OmniFocus: File → Back Up
> Database). See [Safety](#safety).

## How it works

An OmniFocus sync store is a WebDAV collection (`OmniFocus.ofocus/`) containing:

- a baseline transaction and a chain of delta transactions, each a `.zip` holding a
  `contents.xml` describing object creates/updates/deletes;
- `.client` files registering each device and the transaction "tail" it has synced to;
- an `encrypted` plist holding the wrapped document keys.

This server:

1. **Resolves the shard** — `sync.omnigroup.com` 302-redirects each account to a
   `syncN.omnigroup.com` host; the client follows it.
2. **Authenticates** with HTTP Digest (what Omni Sync Server negotiates).
3. **Decrypts** using the OmniFileStore format: PBKDF2 derives a wrapping key from your
   passphrase, RFC 3394 unwraps the document key slots, and each file is AES-128-CTR +
   HMAC-SHA256 in 64 KiB segments (encrypt-then-MAC).
4. **Replays** the transaction chain into an in-memory object model.
5. **Writes** by building a new `contents.xml`, zipping, encrypting, `PUT`-ting it as a
   new transaction descending from the current head tail, and refreshing its `.client`
   registration so other clients treat it as a real participant.

The crypto and format were reimplemented from Omni's **own open-source frameworks**
([OmniGroup/OmniGroup](https://github.com/omnigroup/OmniGroup), notably
`OmniFileStore/EncryptionFormat.md` and `DecryptionExample.py`) plus community
reverse-engineering ([tomzx/ofocus-format](https://github.com/tomzx/ofocus-format),
[rubyfocus](https://github.com/jyruzicka/rubyfocus)). See [CREDITS](#credits).

## Install

```bash
git clone https://github.com/rosskukulinski/omnifocus-sync-mcp.git
cd omnifocus-sync-mcp
npm install
npm run build
```

## Configure

Set credentials via environment variables (see [`.env.example`](./.env.example)):

| Variable | Required | Description |
| --- | --- | --- |
| `OMNIFOCUS_SYNC_USERNAME` | yes | Omni Sync Server account name |
| `OMNIFOCUS_SYNC_PASSWORD` | yes | Omni Sync Server account password |
| `OMNIFOCUS_ENCRYPTION_PASSPHRASE` | no | Defaults to the sync password (OmniFocus's default) |
| `OMNIFOCUS_SYNC_URL` | no | Defaults to `https://sync.omnigroup.com` |
| `OMNIFOCUS_DATABASE` | no | Defaults to `OmniFocus.ofocus` |
| `OMNIFOCUS_CLIENT_NAME` | no | Display name for this client's `.client` file |
| `OMNIFOCUS_CLIENT_STATE_FILE` | no | Where the stable client id is stored |
| `OMNIFOCUS_READ_ONLY` | no | `1`/`true` to refuse all writes |

## Try it without an MCP client

A diagnostic CLI exercises the sync path directly:

```bash
export OMNIFOCUS_SYNC_USERNAME=... OMNIFOCUS_SYNC_PASSWORD=...
npm run probe -- sync            # show database counts
npm run probe -- list flagged    # list flagged tasks
npm run probe -- projects        # list projects
npm run probe -- add "Buy milk"  # add an inbox task
```

## Use as an MCP server

Run over stdio. Example Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "omnifocus": {
      "command": "node",
      "args": ["/absolute/path/to/omnifocus-sync-mcp/dist/index.js"],
      "env": {
        "OMNIFOCUS_SYNC_USERNAME": "your-account",
        "OMNIFOCUS_SYNC_PASSWORD": "your-password"
      }
    }
  }
}
```

### Tools

| Tool | Description |
| --- | --- |
| `of_sync` | Reload the database from the server; returns counts |
| `of_list_tasks` | List tasks (`remaining`, `available`, `flagged`, `inbox`, `due_soon`, `all`), with project/tag/search filters |
| `of_get_task` | Full detail for one task by id |
| `of_list_projects` | List projects with folder path and status |
| `of_add_task` | Create a task (inbox or in a project) |
| `of_complete_task` | Mark a task complete |
| `of_edit_task` | Edit name/note/flag/due/defer; clear dates |

## Safety

- **Back up first**, and prefer a **test account** until you trust the write path.
- Start with `OMNIFOCUS_READ_ONLY=1` to explore safely.
- Writes are append-only transactions; a bad write forks history rather than
  destroying data, and OmniFocus merges forks on its next sync — but that is a
  safety net, not a guarantee.
- Secrets come from the environment only; nothing is written to this repo. The client
  identity file (`client.json`) contains no secrets.

## Development

```bash
npm test          # offline test suite (crypto round-trips, parse/write, digest)
npm run dev -- ... # run the CLI via tsx without building
```

The offline tests cover the risky parts without a network or a real account: the
OmniFileStore encrypt/decrypt round-trip at every segment boundary, MAC tamper
detection, the passphrase→PBKDF2→key-unwrap pipeline, `contents.xml` build/parse
round-trips, partial-update merge semantics, and the full zip→encrypt→decrypt→parse
read path.

## Credits

Built by reimplementing formats documented and open-sourced by others:

- [OmniGroup/OmniGroup](https://github.com/omnigroup/OmniGroup) — Omni's own frameworks;
  `OmniFileStore/EncryptionFormat.md` and `DecryptionExample.py` are the authoritative
  encryption spec, and `OmniFoundation/XML/OFXMLIdentifier.m` the id format.
- [tomzx/ofocus-format](https://github.com/tomzx/ofocus-format) — the `.ofocus`
  transaction/format write-up.
- [jyruzicka/rubyfocus](https://github.com/jyruzicka/rubyfocus),
  [kumpelblase2/focus](https://github.com/kumpelblase2/focus) — prior-art parsers.

Not affiliated with or endorsed by The Omni Group. "OmniFocus" is their trademark.

## License

MIT — see [LICENSE](./LICENSE).
