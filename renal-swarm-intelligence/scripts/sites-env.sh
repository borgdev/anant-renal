#!/usr/bin/env bash

#*****************************************************************************
#
#  Copyright (c) 2026 AnantHQ Inc.
#  All Rights Reserved.
#
#  This software is licensed, not sold.
#
#  The contents of this file constitute confidential and proprietary
#  information belonging exclusively to AnantHQ Inc.
#
#  This source code incorporates proprietary algorithms, software architecture,
#  business logic, computational methods, optimization techniques,
#  workflows, data structures, APIs, and implementation details that are
#  protected by copyright law, patent law, trade secret law, and
#  international intellectual property treaties.
#
#  Except as expressly permitted by a written license agreement,
#  no person or organization may:
#
#    • Copy or reproduce this software.
#    • Modify or create derivative works.
#    • Reverse engineer, decompile, or disassemble.
#    • Benchmark or publicly disclose performance.
#    • Redistribute, sublicense, lease, rent, or sell.
#    • Use this software for competitive analysis.
#    • Disclose any implementation details.
#
#  Any unauthorized use is strictly prohibited and may result in
#  civil damages, injunctive relief, criminal prosecution,
#  and all other remedies available under applicable law.
#
# *****************************************************************************/

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runtime_root="${SITES_RUNTIME_ROOT:-${project_root}/.sites-runtime}"

mkdir -p \
  "${runtime_root}/home" \
  "${runtime_root}/npm-cache" \
  "${runtime_root}/xdg-config" \
  "${runtime_root}/tmp" \
  "${runtime_root}/wrangler/logs"

export SITES_ENV_READY=1
export SITES_PROJECT_ROOT="${project_root}"
export HOME="${runtime_root}/home"
export XDG_CONFIG_HOME="${runtime_root}/xdg-config"
export TMPDIR="${runtime_root}/tmp"
export WRANGLER_WRITE_LOGS=false
export WRANGLER_LOG_PATH="${runtime_root}/wrangler/logs"
export MINIFLARE_REGISTRY_PATH="${runtime_root}/wrangler/registry"

# The runtime may provide a global npm cache. Keep the image's read-only Sites
# seed separate and make this project's writable cache authoritative.
unset NPM_CONFIG_CACHE npm_config_cache || true
export npm_config_cache="${runtime_root}/npm-cache"
export npm_config_audit=false
export npm_config_fund=false
export npm_config_update_notifier=false

# The runtime already supplies the standard HTTP(S)_PROXY variables. Remove
# npm-specific aliases so npm 11 does not reinterpret or warn about them.
unset \
  npm_config_proxy \
  npm_config_http_proxy \
  npm_config_https_proxy \
  NPM_CONFIG_PROXY \
  NPM_CONFIG_HTTP_PROXY \
  NPM_CONFIG_HTTPS_PROXY \
  || true

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "$#" -eq 0 ]]; then
  echo "usage: scripts/sites-env.sh -- command [args...]" >&2
  exit 64
fi

cd "${project_root}"
exec "$@"
