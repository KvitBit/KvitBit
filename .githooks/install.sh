#!/bin/sh
set -eu

if ! command -v git >/dev/null || ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

worktree_config_enabled() {
  [ "$(git config --local --bool --get extensions.worktreeConfig || true)" = true ]
}

if ! worktree_config_enabled && ! git config --local extensions.worktreeConfig true; then
  # A concurrent prepare in another worktree may have installed the shared extension.
  sleep 0.1
  worktree_config_enabled || git config --local extensions.worktreeConfig true
fi
git config --worktree core.hooksPath .githooks
