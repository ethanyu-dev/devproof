#!/usr/bin/env bash

set -Eeuo pipefail

PACKAGE=""
EXPECTED_SHA256=""
PAIR_API=""
PAIR_TOKEN_STDIN=false
FORCE_ACTIVE=false

readonly SERVICE_NAME="devproof-browser-runtime.service"
readonly INSTALL_PREFIX="$HOME/.local"
readonly RUNTIME_HOME="${DEVPROOF_RUNTIME_HOME:-$HOME/.devproof-browser-runtime}"
readonly STATE_PATH="$RUNTIME_HOME/runtime.json"
readonly SERVICE_PATH="$HOME/.config/systemd/user/$SERVICE_NAME"

export PATH="$INSTALL_PREFIX/bin:$PATH"

playwright_browser_options=(--no-shell chromium)

usage() {
  cat <<'EOF'
Install or upgrade a DevProof Browser Runtime package on Linux.

This package installer is invoked by the public release bootstrap or the SSH
deployment helper. Operators normally use the release bootstrap instead.

Usage:
  scripts/install-browser-runtime.sh --package FILE --sha256 HASH [options]

Options:
  --pair-api URL        DevProof API URL for an unpaired device.
  --pair-token-stdin    Read a one-time pairing token from standard input.
  --force-active        Continue when persisted browser sessions are active.
  -h, --help            Show this help.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --package)
      (($# >= 2)) || die "--package requires a path."
      PACKAGE="$2"
      shift 2
      ;;
    --sha256)
      (($# >= 2)) || die "--sha256 requires a hash."
      EXPECTED_SHA256="$2"
      shift 2
      ;;
    --pair-api)
      (($# >= 2)) || die "--pair-api requires a URL."
      PAIR_API="$2"
      shift 2
      ;;
    --pair-token-stdin)
      PAIR_TOKEN_STDIN=true
      shift
      ;;
    --force-active)
      FORCE_ACTIVE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$PACKAGE" && -f "$PACKAGE" ]] || die "a Runtime package is required."
[[ "$EXPECTED_SHA256" =~ ^[[:xdigit:]]{64}$ ]] ||
  die "a valid SHA-256 hash is required."
if [[ -n "$PAIR_API" && "$PAIR_TOKEN_STDIN" == false ]] ||
  [[ -z "$PAIR_API" && "$PAIR_TOKEN_STDIN" == true ]]; then
  die "--pair-api and --pair-token-stdin must be supplied together."
fi
[[ "$(uname -s)" == Linux ]] || die "this installer supports Linux only."
command -v systemctl >/dev/null || die "systemd is required."
systemctl --user show-environment >/dev/null 2>&1 ||
  die "a working systemd user manager is required."

pair_token=""
if [[ "$PAIR_TOKEN_STDIN" == true ]]; then
  IFS= read -r pair_token
  [[ -n "$pair_token" ]] || die "pairing token was empty."
fi

actual_sha256="$(sha256sum "$PACKAGE" | awk '{print $1}')"
[[ "$actual_sha256" == "$EXPECTED_SHA256" ]] ||
  die "package checksum mismatch."

new_device=true
if [[ -f "$STATE_PATH" ]]; then
  new_device=false
fi
if [[ "$new_device" == false && -n "$PAIR_API" ]]; then
  die "this device is already paired; omit --pair-api and --pair-token-stdin."
fi

install_node() {
  local architecture node_arch node_version checksum node_dir temporary tarball
  if ! command -v curl >/dev/null || ! command -v tar >/dev/null ||
    ! command -v xz >/dev/null; then
    command -v apt-get >/dev/null ||
      die "curl, tar, and xz are required; automatic setup supports apt-based Linux distributions."
    sudo -n true >/dev/null 2>&1 ||
      die "passwordless sudo is required to install Node.js prerequisites."
    sudo -n apt-get update
    sudo -n apt-get install -y ca-certificates curl tar xz-utils
  fi
  architecture="$(uname -m)"
  case "$architecture" in
    x86_64) node_arch=x64 ;;
    aarch64|arm64) node_arch=arm64 ;;
    *) die "unsupported CPU architecture: $architecture" ;;
  esac
  node_version="$(
    curl --fail --silent --show-error \
      https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt |
      awk -v arch="$node_arch" '
        $2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {
          version = $2
          sub(/^node-v/, "", version)
          sub("-linux-" arch "\\.tar\\.xz$", "", version)
          print version
          exit
        }
      '
  )"
  [[ -n "$node_version" ]] || die "could not resolve the latest Node.js 24 release."
  mkdir -p "$HOME/.cache"
  temporary="$(mktemp -d "$HOME/.cache/devproof-node.XXXXXX")"
  tarball="node-v$node_version-linux-$node_arch.tar.xz"
  curl --fail --location --show-error --output "$temporary/$tarball" \
    "https://nodejs.org/dist/v$node_version/$tarball"
  checksum="$(curl --fail --silent --show-error "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" | awk -v file="$tarball" '$2 == file { print $1 }')"
  [[ -n "$checksum" ]] || die "Node.js checksum is unavailable."
  printf '%s  %s\n' "$checksum" "$temporary/$tarball" | sha256sum --check --status
  node_dir="$HOME/.local/lib/node-v$node_version"
  mkdir -p "$node_dir" "$HOME/.local/bin"
  tar -xJf "$temporary/$tarball" --strip-components=1 \
    -C "$node_dir"
  ln -sfn "../lib/node-v$node_version/bin/node" "$HOME/.local/bin/node"
  ln -sfn "../lib/node-v$node_version/bin/npm" "$HOME/.local/bin/npm"
  ln -sfn "../lib/node-v$node_version/bin/npx" "$HOME/.local/bin/npx"
  rm -rf "$temporary"
}

if ! command -v node >/dev/null || ! command -v npm >/dev/null ||
  [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  printf 'Installing user-scoped Node.js 24...\n'
  install_node
fi

node_major="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$node_major" == 24 ]] || die "Node.js 24 is required; found $(node --version)."

count_active_sessions() {
  if [[ "$new_device" == true ]]; then
    printf '0\n'
  else
    node - "$STATE_PATH" <<'NODE'
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(state.sessions)) throw new Error("Invalid Runtime state.");
process.stdout.write(String(state.sessions.length));
NODE
  fi
}

active_sessions="$(count_active_sessions)"
if ((active_sessions > 0)) && [[ "$FORCE_ACTIVE" == false ]]; then
  die "$active_sessions persisted browser session(s) are active; retry after they finish or use --force-active."
fi

service_was_active=false
if systemctl --user is-active --quiet "$SERVICE_NAME"; then
  service_was_active=true
fi

rollback_package=""
rollback_dir=""
staging_dir=""
upgrade_started=false
active_child_pid=""
installed_package="$INSTALL_PREFIX/lib/node_modules/@devproof/browser-runtime/package.json"
if [[ -f "$installed_package" ]]; then
  rollback_dir="$(mktemp -d "$HOME/.cache/devproof-runtime-rollback.XXXXXX")"
  rollback_name="$(
    npm pack --silent --pack-destination "$rollback_dir" \
      "$INSTALL_PREFIX/lib/node_modules/@devproof/browser-runtime"
  )"
  rollback_package="$rollback_dir/$rollback_name"
fi

cleanup_files() {
  [[ -z "$staging_dir" ]] || rm -rf -- "$staging_dir"
  [[ -z "$rollback_dir" ]] || rm -rf -- "$rollback_dir"
}

restore_previous() {
  local status=$?
  trap - EXIT HUP INT TERM
  if ((status != 0)); then
    printf 'Upgrade failed; attempting rollback...\n' >&2
    if [[ "$upgrade_started" == true ]]; then
      systemctl --user stop "$SERVICE_NAME" >/dev/null 2>&1 || true
      if [[ -n "$rollback_package" && -f "$rollback_package" ]]; then
        npm install --global --prefix "$INSTALL_PREFIX" "$rollback_package" >/dev/null 2>&1 || true
      fi
    fi
    if [[ "$service_was_active" == true ]] &&
      ! systemctl --user is-active --quiet "$SERVICE_NAME"; then
      systemctl --user start "$SERVICE_NAME" >/dev/null 2>&1 || true
    fi
  fi
  cleanup_files
  exit "$status"
}

stop_for_signal() {
  local status="$1"
  trap - HUP INT TERM
  if [[ -n "$active_child_pid" ]]; then
    if command -v pkill >/dev/null; then
      pkill -TERM -P "$active_child_pid" >/dev/null 2>&1 || true
    fi
    kill -TERM "$active_child_pid" >/dev/null 2>&1 || true
    wait "$active_child_pid" 2>/dev/null || true
    active_child_pid=""
  fi
  exit "$status"
}

run_interruptible() {
  local status=0
  "$@" &
  active_child_pid=$!
  wait "$active_child_pid" || status=$?
  active_child_pid=""
  return "$status"
}

trap restore_previous EXIT
trap 'stop_for_signal 129' HUP
trap 'stop_for_signal 130' INT
trap 'stop_for_signal 143' TERM

staging_dir="$(mktemp -d "$HOME/.cache/devproof-runtime-stage.XXXXXX")"
npm install --prefix "$staging_dir" "$PACKAGE"
staged_package="$staging_dir/node_modules/@devproof/browser-runtime/package.json"
[[ -f "$staged_package" ]] || die "staged Runtime package is incomplete."

playwright_cli="$(
  node - "$staged_package" <<'NODE'
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");
const packagePath = process.argv[2];
const requireFromPackage = createRequire(packagePath);
process.stdout.write(
  join(dirname(requireFromPackage.resolve("playwright/package.json")), "cli.js"),
);
NODE
)"
if [[ "$new_device" == true ]]; then
  sudo -n true >/dev/null 2>&1 ||
    die "a new device requires passwordless sudo to install Chromium system dependencies."
  run_interruptible env PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    node "$playwright_cli" install --with-deps \
    "${playwright_browser_options[@]}"
else
  run_interruptible env PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    node "$playwright_cli" install \
    "${playwright_browser_options[@]}"
fi

active_sessions="$(count_active_sessions)"
if ((active_sessions > 0)) && [[ "$FORCE_ACTIVE" == false ]]; then
  die "$active_sessions persisted browser session(s) became active during staging; retry after they finish or use --force-active."
fi

if [[ "$service_was_active" == true ]]; then
  systemctl --user stop "$SERVICE_NAME"
  active_sessions="$(count_active_sessions)"
  if ((active_sessions > 0)) && [[ "$FORCE_ACTIVE" == false ]]; then
    die "$active_sessions persisted browser session(s) became active during staging; the previous Runtime was restored."
  fi
fi
upgrade_started=true
npm install --global --prefix "$INSTALL_PREFIX" "$PACKAGE"

if ! systemctl --user cat "$SERVICE_NAME" >/dev/null 2>&1; then
  mkdir -p "$(dirname "$SERVICE_PATH")"
  cat >"$SERVICE_PATH" <<EOF
[Unit]
Description=DevProof Browser Runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.config/devproof/browser-runtime.env
ExecStart=%h/.local/bin/devproof-browser-runtime start
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=devproof-browser-runtime
TimeoutStopSec=30
KillMode=control-group
UMask=0077

[Install]
WantedBy=default.target
EOF
fi
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME" >/dev/null
if [[ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]]; then
  sudo -n loginctl enable-linger "$(id -un)" >/dev/null 2>&1 ||
    die "systemd linger is disabled; enable it so the Runtime survives SSH logout."
fi

if [[ ! -f "$STATE_PATH" && -n "$PAIR_API" ]]; then
  printf '%s\n' "$pair_token" |
    "$INSTALL_PREFIX/bin/devproof-browser-runtime" pair \
      --api "$PAIR_API" --token-stdin
  unset pair_token
fi

installed_version="$(node -p "require('$installed_package').version")"
write_install_record() {
  local runtime_id="${1:-}"
  mkdir -p "$RUNTIME_HOME"
  node - "$RUNTIME_HOME/install.json" "$runtime_id" "$installed_version" \
    "$EXPECTED_SHA256" <<'NODE'
const fs = require("node:fs");
const [path, runtimeId, version, packageSha256] = process.argv.slice(2);
const record = {
  installedAt: new Date().toISOString(),
  packageSha256,
  version,
};
if (runtimeId) record.runtimeId = runtimeId;
fs.writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
NODE
}

if [[ ! -f "$STATE_PATH" ]]; then
  write_install_record
  printf 'Runtime package version %s is installed and ready to pair.\n' \
    "$installed_version"
  printf 'Run the one-time pairing command generated by DevProof Console.\n'
  cleanup_files
  trap - EXIT HUP INT TERM
  exit 0
fi

start_epoch="$(date +%s)"
systemctl --user restart "$SERVICE_NAME"
deadline=$((SECONDS + 45))
while ((SECONDS < deadline)); do
  if systemctl --user is-active --quiet "$SERVICE_NAME" &&
    journalctl --user -u "$SERVICE_NAME" --since "@$start_epoch" --no-pager \
      | grep '"event":"runtime.gateway.online"' >/dev/null; then
    break
  fi
  sleep 1
done
systemctl --user is-active --quiet "$SERVICE_NAME" ||
  die "Runtime service did not stay active."
journalctl --user -u "$SERVICE_NAME" --since "@$start_epoch" --no-pager \
  | grep '"event":"runtime.gateway.online"' >/dev/null ||
  die "Runtime service did not report an online connection within 45 seconds."

runtime_id="$(
  node - "$STATE_PATH" <<'NODE'
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
process.stdout.write(state.runtimeId);
NODE
)"
printf 'Runtime %s is online with package version %s.\n' \
  "$runtime_id" "$installed_version"

write_install_record "$runtime_id"

cleanup_files
trap - EXIT HUP INT TERM
