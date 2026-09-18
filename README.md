# Lassi

A CLI for coding agents working with Jira Data Center and Confluence Data Center.
Read issues and comments, download attachments, work in Markdown, and search local exports.

> **Alpha software. Lassi is not production-ready.** Commands, configuration, and file formats
> may change between alpha releases. Live-server coverage is limited. Keep backups, validate
> your workflow, and use a sandbox before relying on write commands.

The initial focus is Jira reading, attachments, exports, and semantic search, with basic
Confluence access. Other existing commands remain available for evaluation. Jira Cloud
compatibility is not claimed. Semantic search indexes exported Markdown, not attachment contents.

## Install

Requires Node.js 24 or newer.

> **npm installation is forthcoming.** The first public alpha has not been published yet.
> Until it is available, follow the [source installation instructions](#development).

Once the first alpha is published, install it with:

```sh
npm install -g @wonna/lassi@alpha
lassi --version
```

The package name is `@wonna/lassi`; the command is `lassi`. Run the same install command to
update to the newest alpha. Check its release notes for configuration or file-format changes.

## Configure

Put personal configuration in `~/.lassi.json`. For example:

```json
{
  "jira": {
    "url": "https://jira.example.internal",
    "tokenFile": "~/.lassi/tokens/jira.txt"
  },
  "embeddings": {
    "url": "https://embeddings.example.internal/v1",
    "model": "example-embedding-model",
    "auth": "azure-ad"
  }
}
```

Embeddings are optional until indexing or searching. Use an OpenAI-compatible endpoint.
`azure-ad` uses Azure Identity credentials, including an existing `az login`. For API keys,
use `bearer` or `api-key` with `embeddings.apiKeyFile` or `LASSI_EMBEDDINGS_API_KEY`.
Keep tokens and generated instance data out of source control. Custom certificate authorities
are supported through `NODE_EXTRA_CA_CERTS`; TLS verification remains enabled.

Configuration precedence is defaults, global file, nearest workspace file, environment, flags.
`--config` or `LASSI_CONFIG` replaces the global file. Workspace `.lassi.json` files may define
field aliases, templates and output preferences, but cannot redirect servers, credential files
or shared export/index storage. `lassi config show --json` explains effective values and sources
with secrets masked. `lassi doctor` checks configuration and server access:

```sh
lassi config show --json
lassi doctor
```

## Agent skills

After configuring Jira, preview and install the global Jira skill:

```sh
lassi skills install --global --only jira --dry-run
lassi skills install --global --only jira
```

The skill and its command references are installed into `~/.agents/skills/jira/`. Add `lassi`
to your agent's command permissions and reload its skills. Omit `--only jira` to install both
Jira and Confluence skills.

Back up customized skills and review differences before using `--force`; the installer refuses
to overwrite changed instructions by default. Refresh the skills after a CLI upgrade to keep
command references current.

## Read and search

Replace `PROJ-123` with an issue you can access:

```sh
lassi jira issue get PROJ-123 --all --json
lassi jira attach get PROJ-123 --json
```

For semantic search, export a set of issues and index the resulting Markdown. Replace the
example JQL with the issues you want to search:

```sh
lassi jira issue export 'project = PROJ' --comments
lassi search index
lassi search query 'How are failed deployments recovered?'
```

Indexing sends document chunks to your configured embedding service. Queries send the search
text to that service and compare its vector with the local index. Re-running `lassi search index`
reuses embeddings for unchanged documents when the model and chunking settings match.

Fresh installations export under `~/.lassi/export/jira` and store indexes under
`~/.lassi/index/`. Working files, caches and downloaded attachments use `.lassi/` in the
working directory. Configure `storage.exportDir` and `storage.indexDir` for other shared paths.

Output is Markdown by default, one JSON document with `--json`, or compact TOON with `--axi`.
Errors include a structured JSON line on stderr. `--dry-run` previews writes; `LASSI_READ_ONLY=1`
blocks write commands before network access. Exporting is a read of the server and writes local
files; read-only mode does not prohibit that local export. Use `lassi help --all` for all commands.

## Development

To run from source, clone this repository and enter the checkout:

```sh
npm ci
npm run build
npm link --workspace packages/cli
lassi --version
```

The link uses this checkout. Keep it in place while using Lassi. To update a source installation,
run these commands from the same checkout:

```sh
git pull --ff-only
npm ci
npm run build
```

Before submitting changes, run:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run test:package
```

Tests use fabricated fixtures and injected network clients. No automated test calls a real Jira,
Confluence, or embeddings service. Package verification installs the actual tarball into an
isolated temporary directory and exercises the installed command and skills with fabricated data.

After building, `npm run pack` writes a standalone npm tarball under `artifacts/`. Dependency
installation, building, package verification, and packing do not publish to the npm registry.

Release preparation and publication are described in [RELEASING.md](https://github.com/wonna-fi/lassi/blob/main/RELEASING.md).

## License

MIT. See [LICENSE](LICENSE).
