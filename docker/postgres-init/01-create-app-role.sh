#!/bin/sh
set -eu

# The entrypoint creates the runtime role before migrations on fresh volumes.
# Compose mounts the same script used by the post-migration reconcile service.
reconcile="$(dirname "$0")/../reconcile-app-role.sh"
if [ -f "$reconcile" ]; then
  exec sh "$reconcile" --init
fi
exec sh /usr/local/bin/reconcile-app-role.sh --init
