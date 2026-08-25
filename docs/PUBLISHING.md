# Publishing fraud-sim

How to ship a new version to GitHub and npm. Package name: `fraud-sim`. Current version is in `package.json`.

## Prerequisites

- Node.js 20+
- Write access to [github.com/frisklayer/fraud-sim](https://github.com/frisklayer/fraud-sim)
- An [npm](https://www.npmjs.com/) account with publish rights for `fraud-sim`
- Logged in locally: `npm login` (or `npm whoami` to confirm)

## What gets published

**GitHub** — everything not listed in `.gitignore` (source, tests, examples, public docs).

**npm** — only what `package.json` `"files"` allows:

```
src/
README.md
LICENSE
CHANGELOG.md
```

Examples, tests, and `docs/` stay on GitHub; they are not in the npm tarball.

---

## 1. Prep the release

1. Pull latest `main` and make sure the working tree is clean.
2. Run the full test suite:

   ```bash
   npm test
   npm run test:integration
   ```

3. Update `CHANGELOG.md` under a new version heading (Keep a Changelog format).
4. Bump the version in `package.json` (semver):

   | Change | Bump |
   |--------|------|
   | Bug fix / docs | patch (`0.2.0` → `0.2.1`) |
   | New scenario / feature | minor (`0.2.0` → `0.3.0`) |
   | Breaking API change | major (`0.2.0` → `1.0.0`) |

   Or use npm:

   ```bash
   npm version patch   # or minor / major
   ```

   That updates `package.json` and creates a git tag. Prefer doing the changelog edit *before* `npm version` if you want the tag commit to include both.

---

## 2. Dry-run the npm package

Confirm the tarball only contains what you intend:

```bash
npm pack --dry-run
```

Optional: pack for real, inspect, then delete:

```bash
npm pack
tar -tf fraud-sim-*.tgz
# Windows PowerShell: tar -tf (Get-Item fraud-sim-*.tgz).Name
Remove-Item fraud-sim-*.tgz
```

---

## 3. Push to GitHub

```bash
git add package.json CHANGELOG.md
# include any other release commits
git commit -m "Release v0.2.1"
git push origin main
git push origin v0.2.1   # if npm version created the tag; adjust version
```

If you bumped the version by hand (no tag yet):

```bash
git tag v0.2.1
git push origin v0.2.1
```

Optional: create a GitHub Release from the tag (`gh release create v0.2.1 --generate-notes`).

---

## 4. Publish to npm

First release (or after a long gap), check the name is still yours:

```bash
npm view fraud-sim version
```

Then publish:

```bash
npm publish
```

For a scoped package you would need `--access public`. This package is unscoped (`fraud-sim`), so a normal `npm publish` is enough.

Verify:

```bash
npm view fraud-sim version
npm install fraud-sim@latest
```

---

## 5. Post-publish checklist

- [ ] npm page shows the new version: https://www.npmjs.com/package/fraud-sim
- [ ] GitHub tag/release exists
- [ ] CI is green on `main`
- [ ] README install snippet still matches (`npm install fraud-sim`)

---

## Common issues

| Problem | Fix |
|---------|-----|
| `You do not have permission to publish` | You are not an owner/maintainer of the package — ask an existing owner to `npm owner add <you> fraud-sim` |
| `Package name too similar` / name taken | Confirm with `npm view fraud-sim`; do not rename lightly |
| Wrong files in the tarball | Adjust `"files"` in `package.json`, then `npm pack --dry-run` again |
| Published a bad version | Publish a patched version; do not unpublish except within npm’s short unpublish window and only if safe |
| 2FA required | Use an automation token or complete OTP when prompted |

---

## Local files that must never ship

AI implementation guides and plans are gitignored (see `.gitignore`):

- `guides/`
- `IMPLEMENTATION_GUIDE.md`
- Cursor / Claude / plan artifacts

Do not force-add those. They are for local / AI-assisted development only.
