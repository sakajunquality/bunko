#!/usr/bin/env bash
set -euo pipefail
# Validation runners use the reviewed Linux amd64 binary.
[[ "$(uname -s)" = Linux && "$(uname -m)" = x86_64 ]]
destination=${1:?usage: install-cosign.sh DESTINATION}
curl --fail --location --retry 3 --max-time 120 https://github.com/sigstore/cosign/releases/download/v3.1.3/cosign-linux-amd64 --output "$destination"
printf '4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71  %s\n' "$destination" | sha256sum --check
chmod 755 "$destination"
