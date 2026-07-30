#!/bin/sh
#
# Vercel interprets any non-zero ignoreCommand exit as "build". Running the
# Node policy directly would therefore fail open on a syntax/import/runtime
# crash. This wrapper maps only the policy's exact intentional sentinel + exit
# code to a dedicated wrapper result. vercel.json's outer immutable mapping
# converts only that result to Vercel's build exit; every other wrapper/startup
# outcome is a fail-closed skip.

output_file="$(mktemp "${TMPDIR:-/tmp}/axis-vercel-ignore.XXXXXX")" || exit 0
trap 'rm -f "$output_file"' 0 HUP INT TERM

node scripts/vercel-ignore-build.mjs >"$output_file" 2>&1
child_status=$?
cat "$output_file"

last_line="$(tail -n 1 "$output_file" 2>/dev/null)"
if [ "$child_status" -eq 73 ] && \
  [ "$last_line" = "AXIS_VERCEL_DECISION=BUILD" ]; then
  exit 74
fi

exit 0
