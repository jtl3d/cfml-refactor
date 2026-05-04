# CFML Refactor

A VS Code extension to detect and refactor database queries in CFML files. Not published to the VS Code Marketplace; distributed as a sideloaded `.vsix`.

## Commands

- `CFML Refactor: Detect Queries`
- `CFML Refactor: Convert Queries In Place`
- `CFML Refactor: Hoist Queries`
- `CFML Refactor: Index Workspace`
- `CFML Refactor: Find Similar Queries`
- `CFML Refactor: Find Extractable Functions`
- `CFML Refactor: Find Extractable Functions (Workspace)`

## Development

```bash
npm install
npm run build      # dev build (sourcemaps, no minify)
npm run watch      # rebuild on change
npm test           # compile tests + run mocha
npm run typecheck  # tsc --noEmit
```

## Deployment

### Local packaging (no git push)

```bash
npm run package:patch    # bumps version, builds .vsix into dist/
```

The .vsix file appears in `dist/`. Copy to the target machine and install:

```bash
code --install-extension dist/cfml-refactor-X.Y.Z.vsix
```

Use `package` (no version bump) for testing the package step itself, or `package:minor` for a minor bump.

### Release via GitHub

```bash
npm run release:patch    # bumps version, commits, tags, pushes
```

GitHub Actions builds the .vsix and attaches it to a new Release. Download from the Releases page on the target machine.

### Installing on the sandbox

```bash
code --install-extension /path/to/cfml-refactor-X.Y.Z.vsix
```

Then reload the VS Code window: Ctrl+Shift+P -> "Developer: Reload Window".

To verify:

```bash
code --list-extensions | grep cfml-refactor
```

### Reinstalling after an update

VS Code may cache the old version. If a new install doesn't take effect:

```bash
code --uninstall-extension <publisher>.cfml-refactor
code --install-extension /path/to/cfml-refactor-X.Y.Z.vsix
```
