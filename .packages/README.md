# Package lists

System packages and Python dependencies required to build Slopsmith Desktop.

## Files

| File | Purpose |
|---|---|
| `apt.txt` | Ubuntu/Debian system packages (apt) |
| `brew.txt` | macOS system packages (Homebrew) |
| `choco.txt` | Windows system packages (Chocolatey) |
| `python.txt` | Python packages (pip) - **shared across all platforms** |

## Purpose

Single source of truth for dependencies across:
- **Local development** (via `.devcontainer/`)
- **GitHub Actions CI** (`.github/workflows/build.yml`)
- **Manual installation** by contributors

## Usage

### System packages

For system packages, filter out comments and blank lines before piping:

```bash
# Ubuntu/Debian
grep -v '^[[:space:]]*#' .packages/apt.txt | grep -v '^[[:space:]]*$' | xargs sudo apt-get install -y

# macOS
grep -v '^[[:space:]]*#' .packages/brew.txt | grep -v '^[[:space:]]*$' | xargs brew install

# Windows (PowerShell)
Get-Content .packages/choco.txt | Where-Object { $_ -notmatch '^\s*#' -and $_ -notmatch '^\s*$' } | ForEach-Object { choco install $_ -y }
```

### Python packages

The `python.txt` file is used directly by pip during the bundle step:

```bash
pip install -r .packages/python.txt
```

This file is referenced from:
- `scripts/build-windows.sh` (Windows)
- `scripts/build-macos.sh` (macOS)
- `scripts/bundle-python.sh` (Linux)

## Format

- One package per line
- Lines starting with `#` are comments
- Blank lines are ignored
- Standard `pip install -r` format for `python.txt`

## Updating

### Adding system dependencies
1. Add to the appropriate `.packages/*.txt` for each OS
2. Update `.devcontainer/` if applicable
3. Test locally

### Adding Python dependencies
1. Add to `.packages/python.txt` (one file for all platforms)
2. Ensure the package is available on all platforms
3. Test builds on all three platforms

Changes affect both local builds and CI, so verify end-to-end before merging.
