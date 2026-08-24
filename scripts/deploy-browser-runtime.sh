#!/usr/bin/env bash

set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly REMOTE_INSTALLER="$SCRIPT_DIR/install-browser-runtime.sh"

SSH_IDENTITY=""
SSH_EXTRA_OPTIONS=()
PAIR_API=""
PAIR_TOKEN=""
FORCE_ACTIVE=false
SKIP_BUILD=false
TARGETS=()

usage() {
  cat <<'EOF'
Build and deploy the DevProof Browser Runtime to one or more Linux hosts.

Usage:
  scripts/deploy-browser-runtime.sh [options] user@host [user@host ...]

Options:
  --identity PATH       SSH private key used for every target.
  --ssh-option OPTION   Additional ssh/scp -o option; may be repeated.
                        Example: --ssh-option ProxyJump=user@bastion
  --pair-api URL        DevProof API URL for a new, unpaired device.
  --pair-token          Prompt securely for a new device's one-time pairing
                        token. Only one target may be supplied in this mode.
  --force-active        Upgrade even when persisted browser sessions are active.
  --skip-build          Reuse the newest release/devproof-browser-runtime-*.tgz.
  -h, --help            Show this help.

Examples:
  scripts/deploy-browser-runtime.sh \
    --identity ~/.ssh/devproof-browser-runtime \
    ppuser@10.1.80.119

  scripts/deploy-browser-runtime.sh \
    --identity ~/.ssh/devproof-browser-runtime \
    --pair-api https://devproof.example.com \
    --pair-token \
    ppuser@new-runtime-host
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

expand_home() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s/%s\n' "$HOME" "${1#~/}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

while (($#)); do
  case "$1" in
    --identity)
      (($# >= 2)) || die "--identity requires a path."
      SSH_IDENTITY="$(expand_home "$2")"
      shift 2
      ;;
    --ssh-option)
      (($# >= 2)) || die "--ssh-option requires a value."
      [[ -n "$2" && "$2" != -* ]] ||
        die "--ssh-option expects an ssh_config key or key=value."
      SSH_EXTRA_OPTIONS+=(-o "$2")
      shift 2
      ;;
    --pair-api)
      (($# >= 2)) || die "--pair-api requires a URL."
      PAIR_API="$2"
      shift 2
      ;;
    --pair-token)
      [[ -z "$PAIR_TOKEN" ]] || die "--pair-token may only be used once."
      [[ -t 0 ]] || die "--pair-token requires an interactive terminal."
      read -r -s -p 'DevProof pairing token: ' PAIR_TOKEN
      printf '\n'
      [[ -n "$PAIR_TOKEN" ]] || die "pairing token was empty."
      shift
      ;;
    --force-active)
      FORCE_ACTIVE=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      ;;
    -*) die "unknown option: $1" ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done

((${#TARGETS[@]} > 0)) || die "provide at least one user@host target."
if [[ -n "$PAIR_API" && -z "$PAIR_TOKEN" ]] ||
  [[ -z "$PAIR_API" && -n "$PAIR_TOKEN" ]]; then
  die "--pair-api and --pair-token must be supplied together."
fi
if [[ -n "$PAIR_TOKEN" && ${#TARGETS[@]} -ne 1 ]]; then
  die "a one-time pairing token can only be used with one target."
fi
[[ -z "$SSH_IDENTITY" || -f "$SSH_IDENTITY" ]] ||
  die "SSH identity does not exist: $SSH_IDENTITY"
[[ -x "$REMOTE_INSTALLER" ]] ||
  die "remote installer is not executable: $REMOTE_INSTALLER"

command -v ssh >/dev/null || die "ssh is required."
command -v scp >/dev/null || die "scp is required."

sha256_file() {
  if command -v shasum >/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  else
    die "shasum or sha256sum is required."
  fi
}

ssh_options=(
  -o BatchMode=yes
  -o ConnectTimeout=15
  -o StrictHostKeyChecking=accept-new
)
if ((${#SSH_EXTRA_OPTIONS[@]})); then
  ssh_options+=("${SSH_EXTRA_OPTIONS[@]}")
fi
if [[ -n "$SSH_IDENTITY" ]]; then
  ssh_options+=(-o IdentitiesOnly=yes -i "$SSH_IDENTITY")
fi

if [[ "$SKIP_BUILD" == false ]]; then
  command -v pnpm >/dev/null || die "pnpm is required to build the Runtime."
  (
    cd "$REPO_ROOT"
    pnpm install --frozen-lockfile
    pnpm build:packages
    pnpm --filter @devproof/browser-runtime build
    mkdir -p release
    pnpm --filter @devproof/browser-runtime \
      pack --pack-destination "$REPO_ROOT/release"
  )
fi

shopt -s nullglob
packages=("$REPO_ROOT"/release/devproof-browser-runtime-*.tgz)
shopt -u nullglob
((${#packages[@]} > 0)) ||
  die "no Runtime package found under $REPO_ROOT/release."
package="${packages[0]}"
for candidate in "${packages[@]:1}"; do
  [[ "$candidate" -nt "$package" ]] && package="$candidate"
done

package_sha256="$(sha256_file "$package")"
printf 'Deploying %s (%s)\n' "$(basename "$package")" "$package_sha256"

for target in "${TARGETS[@]}"; do
  [[ "$target" =~ ^[A-Za-z_][A-Za-z0-9._-]*@[A-Za-z0-9._:-]+$ ]] ||
    die "target must be user@host: $target"
  printf '\n==> %s\n' "$target"
  remote_output="$(
    ssh "${ssh_options[@]}" "$target" \
      'set -eu; umask 077; mkdir -p "$HOME/.cache"; mktemp -d "$HOME/.cache/devproof-runtime-deploy.XXXXXX"'
  )"
  remote_dir="$(printf '%s\n' "$remote_output" | tail -1)"
  [[ "$remote_dir" =~ ^/[A-Za-z0-9._/-]+/devproof-runtime-deploy\.[A-Za-z0-9]+$ ]] &&
    [[ "$remote_dir" != *"/../"* ]] ||
    die "target returned an unexpected temporary directory: $remote_dir"

  cleanup() {
    local cleanup_command
    printf -v cleanup_command '%q ' rm -rf -- "$remote_dir"
    ssh "${ssh_options[@]}" "$target" "$cleanup_command" \
      >/dev/null 2>&1 || true
  }
  trap cleanup EXIT

  scp "${ssh_options[@]}" \
    "$REMOTE_INSTALLER" "$package" \
    "$target:$remote_dir/"

  remote_args=(
    --package "$remote_dir/$(basename "$package")"
    --sha256 "$package_sha256"
  )
  [[ "$FORCE_ACTIVE" == true ]] && remote_args+=(--force-active)
  if [[ -n "$PAIR_TOKEN" ]]; then
    remote_args+=(--pair-api "$PAIR_API" --pair-token-stdin)
  fi

  printf -v remote_command '%q ' \
    "$remote_dir/$(basename "$REMOTE_INSTALLER")" "${remote_args[@]}"
  if [[ -n "$PAIR_TOKEN" ]]; then
    printf '%s\n' "$PAIR_TOKEN" |
      ssh "${ssh_options[@]}" "$target" "$remote_command"
  else
    ssh "${ssh_options[@]}" "$target" "$remote_command"
  fi

  cleanup
  trap - EXIT
done

printf '\nDeployment completed for %d target(s).\n' "${#TARGETS[@]}"
