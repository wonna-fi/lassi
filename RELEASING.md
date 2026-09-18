# Releasing Lassi

Every npm version must have its source available under the matching public tag in
`wonna-fi/lassi` before publication. Only the standalone `@wonna/lassi` package is published.
The workspace root and all workspace packages remain private.

## Prepare an alpha

Set an explicit version without creating a commit or tag:

```sh
npm run release:version -- 0.1.0-alpha.2
```

This updates the root, all workspace manifests, and their lockfile entries together. It does
not change dependency resolutions. Use `npm run release:version -- --check` to verify them.
Stable and beta versions require a separate change to the release policy.

Review the changes and prepare release notes describing new behavior, fixes, known limitations,
and any required configuration, skill, export, or index updates. Commit the version change.
Before the first public release, replace the README's forthcoming-installation notice with
normal npm installation instructions.

## Rehearse without publishing

Use Node.js 24 or newer, Git, and `tar`. The GitHub runners provide these tools.
From a checkout with dependencies installed using `npm ci`:

```sh
npm run release:rehearse
```

This runs the checks, builds and packs the CLI, installs and tests the exact tarball, checks its
version and source commit, and runs `npm publish --dry-run`. It does not publish a package or
verify npm publishing permissions. It prints the package checksum for inspection.

The Release workflow runs this rehearsal for relevant pull requests and manual dispatches.
It uploads the resulting tarball as `release-candidate`, then tests that same file on Linux
and Windows. SHA-512 checks before and after verification bind every job to the original file.
Artifacts are retained for 14 days. Downloading the workflow artifact yields a ZIP containing
the npm tarball; the ZIP itself is not an npm package.

Rehearsals can run in any repository. Manual workflow runs never publish. The publishing job
runs only for an alpha tag push in the public `wonna-fi/lassi` repository, with publication
explicitly enabled. No registry credentials are needed for rehearsals. All release jobs install the same pinned
npm version, including the publishing job, so OIDC support does not depend on the version
bundled with Node.js. Keep that pin at npm 11.5.1 or newer.

## First publication and npm setup

1. Make the reviewed source available in the public repository. Protect `main` and release tags
   from unintended changes, including tag updates and deletion.
2. Run a rehearsal there and review its artifact and CI results.
3. Create the matching public tag and GitHub prerelease notes. For example,
   `v0.1.0-alpha.1` identifies package version `0.1.0-alpha.1`. Never move a published tag.
4. The first registry publication needs an authenticated npm maintainer with permission to
   publish `@wonna/lassi`. Keep automated publication disabled for this bootstrap. After the
   tag's Release workflow passes, download its tested tarball and compare its SHA-512 with
   the workflow output. Publish that exact tarball with public access and the `alpha` tag.
   Do not publish a placeholder version or an artifact built from another checkout.
5. Configure npm trusted publishing for organization `wonna-fi`, repository `lassi`, workflow
   `release.yml`, and environment `npm`. Allow direct `npm publish` for this publisher.
6. Create the GitHub environment `npm` and configure its required reviewer and release-tag
   restrictions. Then set repository variable `NPM_PUBLISH_ENABLED` to `true`.

The initial authenticated publication must follow the same source-first rule. It establishes
the package so its trusted publisher can be configured. Later releases use GitHub Actions
OIDC without a long-lived npm token. The first local publication does not carry the automated
workflow provenance of later trusted-publisher releases; its source tag, build metadata, and
published tarball checksum remain available for comparison.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Subsequent releases

Merge the reviewed release changes into public `main`, then push its matching `v*-alpha.*`
tag and prepare GitHub prerelease notes. A normal branch push or PR merge does not publish.
The tag workflow builds and tests the package. The `npm` environment reviewer approves the
publishing job after those checks pass.

Immediately before publishing, the job checks the exact artifact hash, version, full source
commit, clean build, and local tag. It anonymously reads GitHub to verify that the source
repository is public and the public tag resolves to that same commit. An inaccessible API,
private repository, or mismatched tag fails the job before `npm publish`.

The workflow publishes the already tested tarball with `--access public --tag alpha` and
provenance. Verify the registry version, the `alpha` tag, and an installation from npm after
publication. Mark the corresponding GitHub release as a prerelease and keep its release notes
current. Reserve `latest` for a future release intended for ordinary installs.

If authorization fails, fix the setup and rerun against the same unchanged tag. If a version
has already been published, inspect the registry before retrying; never replace its source
or reuse its version for different package contents.
