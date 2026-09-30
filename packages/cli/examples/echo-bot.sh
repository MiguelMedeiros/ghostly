#!/usr/bin/env bash
# An echo bot: every message it receives comes back as "echo: <text>".
# Needs jq. Run `ghostly daemon --detach` first (or let `listen` run the profile itself).
set -euo pipefail
cursor="${ECHO_CURSOR:-$HOME/.ghostly/echo.cursor}"
exec ghostly listen --type message.received --cursor "$cursor" --exec '
  event="$(cat)"
  chat="$(printf "%s" "$event" | jq -r .chat)"
  text="$(printf "%s" "$event" | jq -r .message.text)"
  # The text goes on stdin: a message that starts with "-" is text, not an option.
  printf "echo: %s" "$text" | ghostly send "$chat" --stdin >/dev/null
'
