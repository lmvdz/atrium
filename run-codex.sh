#!/usr/bin/env bash
cd "$(dirname "$0")"
codex exec -s read-only --model gpt-5.6-terra -c model_reasoning_effort=high "$(cat critic-prompt.txt)" < /dev/null > codex-r5.txt 2>&1
echo "codex exit=$?" >> codex-r5.txt
