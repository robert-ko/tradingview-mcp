#!/usr/bin/env bash
# Source this file to get the `tv` alias in your current shell:
#   source scripts/setup_env.sh
#
# To make it permanent, add to ~/.bashrc:
#   echo "source $(pwd)/scripts/setup_env.sh" >> ~/.bashrc
#
# CDP host (WSL2): connection.js auto-detects the right host -- it probes loopback
# first (works under WSL2 mirrored networking, which shares 127.0.0.1 with Windows)
# and falls back to the Windows gateway IP (default NAT networking). To force a host,
# export CDP_HOST before sourcing, e.g. for mirrored networking:
#   export CDP_HOST=127.0.0.1
# See docs/WINDOWS_WSL2_SETUP.md for the full Windows/WSL2 setup.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TV_CLI="$SCRIPT_DIR/../src/cli/index.js"

alias tv="node $TV_CLI"
echo "tv alias set → node $TV_CLI"
