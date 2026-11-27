#!/bin/sh
# Perch installer.
#
# Downloads the standalone perch binary for this OS/CPU from GitHub Releases,
# verifies it against the release's SHA256SUMS.txt, and installs it as
# "$PERCH_INSTALL_DIR/perch" (default: ~/.local/bin/perch).
#
#   curl -fsSL https://ohyee.github.io/perch/install.sh | sh
#   curl -fsSL https://ohyee.github.io/perch/install.sh | sh -s -- --beta --with-omp --with-agy
#
# Options:
#   --beta            install the newest release, including pre-releases
#   --version <v>     install an exact version, e.g. 0.3.0 or 0.4.0-beta-c645e9c22906
#   --dir <path>      install directory (default: ~/.local/bin, env PERCH_INSTALL_DIR)
#   --with-omp        run "perch integration install omp" after installing
#   --with-agy        run "perch integration install agy" after installing
#   -h, --help        show this help
#
# The binary needs no Node.js. Supported: macOS and Linux (glibc), arm64 and x64.
set -eu

REPO="OhYee/perch"
INSTALL_DIR="${PERCH_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${PERCH_VERSION:-}"
CHANNEL="stable"
INTEGRATIONS=""

say() { printf '%s\n' "perch-install: $*"; }
die() { printf '%s\n' "perch-install: error: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --beta) CHANNEL="beta" ;;
    --version) [ $# -ge 2 ] || die "--version needs a value"; VERSION="$2"; shift ;;
    --version=*) VERSION="${1#--version=}" ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a value"; INSTALL_DIR="$2"; shift ;;
    --dir=*) INSTALL_DIR="${1#--dir=}" ;;
    --with-omp) INTEGRATIONS="$INTEGRATIONS omp" ;;
    --with-agy) INTEGRATIONS="$INTEGRATIONS agy" ;;
    -h|--help)
      printf '%s\n' "Usage: install.sh [--beta | --version <v>] [--dir <path>] [--with-omp] [--with-agy]"
      exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) die "unsupported OS $(uname -s); Perch supports macOS and Linux" ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) die "unsupported CPU $(uname -m); Perch supports arm64 and x64" ;;
esac
asset="perch-$os-$arch"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 --proto '=https' -o "$2" "$1"; }
  fetch_stdout() { curl -fsSL --retry 3 --proto '=https' "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
  fetch_stdout() { wget -q -O - "$1"; }
else
  die "curl or wget is required"
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "sha256sum or shasum is required to verify the download"
fi

# Resolve which release to download.
if [ -n "$VERSION" ]; then
  tag="v${VERSION#v}"
  base="https://github.com/$REPO/releases/download/$tag"
elif [ "$CHANNEL" = "beta" ]; then
  # The releases Atom feed includes pre-releases and is not subject to the
  # unauthenticated REST API rate limit. Pick the most recently updated entry.
  tag="$(fetch_stdout "https://github.com/$REPO/releases.atom" | awk '
    /<entry>/ { updated = ""; tag = "" }
    /<updated>/ { if (updated == "") { s = $0; sub(/.*<updated>/, "", s); sub(/<\/updated>.*/, "", s); updated = s } }
    /releases\/tag\// { if (tag == "") { s = $0; sub(/.*releases\/tag\//, "", s); sub(/".*/, "", s); tag = s } }
    /<\/entry>/ { if (tag != "") print updated, tag }
  ' | sort -r | head -n 1 | cut -d ' ' -f 2)" || true
  [ -n "$tag" ] || die "could not determine the newest release; retry or pass --version"
  base="https://github.com/$REPO/releases/download/$tag"
else
  tag="latest stable"
  base="https://github.com/$REPO/releases/latest/download"
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t perch-install)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $asset ($tag)"
fetch "$base/$asset" "$tmp/$asset" || die "download failed: $base/$asset"
fetch "$base/SHA256SUMS.txt" "$tmp/SHA256SUMS.txt" || die "download failed: $base/SHA256SUMS.txt"

expected="$(awk -v name="$asset" '{ n = $2; sub(/^\*/, "", n) } n == name { print $1; c++ } END { if (c != 1) exit 1 }' "$tmp/SHA256SUMS.txt")" \
  || die "SHA256SUMS.txt has no single entry for $asset"
actual="$(sha256 "$tmp/$asset")"
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset (expected $expected, got $actual)"
say "checksum verified"

chmod 755 "$tmp/$asset"
mkdir -p "$INSTALL_DIR"
target="$INSTALL_DIR/perch"
if [ -L "$target" ]; then
  say "replacing existing symlink $target -> $(readlink "$target")"
  rm -f "$target"
elif [ -d "$target" ]; then
  die "$target is a directory"
fi
mv -f "$tmp/$asset" "$target"
say "installed $("$target" --version 2>/dev/null || echo perch) to $target"

for integration in $INTEGRATIONS; do
  say "running: perch integration install $integration"
  "$target" integration install "$integration"
done

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say "$INSTALL_DIR is not in PATH. Add this to your shell profile:"
    printf '\n  export PATH="%s:$PATH"\n\n' "$INSTALL_DIR" ;;
esac
say "done. Update later with: perch update"
