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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${SITES_ENV_READY:-}" != "1" ]]; then
  exec "${script_dir}/sites-env.sh" -- "$0" "$@"
fi

command -v timeout || {
  echo "build-verified.sh requires GNU timeout." >&2
  exit 69
}

vinext="${SITES_PROJECT_ROOT}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run npm run install:ci and wait for it to finish before building." >&2
  exit 69
fi

echo "Running bounded vinext build..."
timeout \
  --signal=TERM \
  --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" \
  "${SITES_BUILD_TIMEOUT:-3m}" \
  "${vinext}" build
