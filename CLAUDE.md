# Hot Take: notes for Claude

Phone-based party card game. Node + Express + Socket.IO server (`server/`), plain HTML/CSS/JS client (`public/`),
decks in `data/decks/`. Run `npm test` before committing. See README.md for everything else.

## Releases: always remind the owner to tag

The Docker image `ghcr.io/mhudrlik/hot-take` is published by `.github/workflows/docker-publish.yml`:
every push to `main` updates `:latest`, and a `vX.Y.Z` git tag publishes `X.Y.Z`, `X.Y` and `X`.

**Whenever changes have been pushed to `main` and the commits since the latest `v*` tag change what players or
server admins get (anything other than docs, tests, screenshots or CI-only tweaks), end your reply with a release
reminder.** It must include:

1. The latest tag (`git describe --tags --abbrev=0`) and a one-line summary of what's changed since it
   (`git log --oneline <tag>..HEAD`).
2. A suggested next version, following semantic versioning:
   - **Major** (`2.0.0`): breaking for people running it, e.g. a renamed/removed env var, a changed deck file format,
     a changed port or volume path, or anything that needs manual steps to upgrade.
   - **Minor** (`1.1.0`): new features that don't break anything, e.g. new settings, new decks, new game options or
     screens.
   - **Patch** (`1.0.1`): bug fixes, card text fixes, styling tweaks, dependency updates.
3. The exact commands, using the suggested version:

   ```bash
   npm version X.Y.Z --no-git-tag-version   # keep package.json in step with the tag
   git commit -am "Release X.Y.Z"
   git tag -a vX.Y.Z -m "Hot Take X.Y.Z"
   git push origin main vX.Y.Z
   ```

Don't create or push a tag yourself unless the owner asks; just remind and suggest. If nothing release-worthy has
changed since the last tag, don't remind.

## Commits

Author commits as `Matt Hudrlik <25089476+mhudrlik@users.noreply.github.com>` (never a work email). This is a
personal project; don't reference any employer.
