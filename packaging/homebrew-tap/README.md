# blowhorn-ai/homebrew-tap

Homebrew formulae from [Blowhorn](https://blowhorn.ai).

## Tells

[Tells](https://tells.blowhorn.ai) runs the Blowhorn Tells bot-detection check from a terminal and prints the JSON report and a one-line verdict.

```bash
brew install blowhorn-ai/tap/tells
tells --server-only
```

`brew install` pulls in Homebrew's `node`. The formula installs the `blowhorn-tells` package from the npm registry and links its `tells` command. `tells --help` lists the flags and exit codes; the [Tells README](https://github.com/blowhorn-ai/tells#cli) documents the output.

`--server-only` needs nothing else. The default browser run loads Playwright, which a Homebrew install cannot find. For browser runs install with npm instead: `npm i -g blowhorn-tells playwright && npx playwright install chromium`.

## How the formula stays current

`Formula/tells.rb` is generated. Do not edit it by hand.

`.github/workflows/update-formula.yml` runs every six hours and on demand (Actions > Update formula > Run workflow). It:

1. reads the latest `blowhorn-tells` version and its tarball from the public npm registry, and checks the tarball against the registry's sha512 integrity,
2. renders `Formula/tells.rb` with `scripts/render-homebrew-formula.mjs` from [blowhorn-ai/tells](https://github.com/blowhorn-ai/tells), which reads the package, tap and formula names from `schemas/cli-release.json`,
3. if the formula changed, runs `brew install`, `brew test` and `brew audit` on it, then commits `tells <version>` and pushes.

It uses only this repo's `GITHUB_TOKEN` (`contents: write`). There is no npm token and no cross-repo secret. GitHub turns off scheduled workflows in a public repo after 60 days without activity; if that happens, re-enable the workflow under Actions or run it by hand after a release.

## Bootstrap

The source of these files is [`packaging/homebrew-tap/`](https://github.com/blowhorn-ai/tells/tree/master/packaging/homebrew-tap) in blowhorn-ai/tells. To create this repo:

1. Publish `blowhorn-tells` to npm first (the workflow fails while the package has no release).
2. Create the public repo `blowhorn-ai/homebrew-tap` with a `main` branch, and copy in `README.md` and `.github/workflows/update-formula.yml`.
3. Leave GitHub Actions enabled for the repo. The workflow declares `permissions: contents: write` itself, so there is no token or secret to add.
4. Run Actions > Update formula once. It writes `Formula/tells.rb`, and `brew install blowhorn-ai/tap/tells` works from then on.
