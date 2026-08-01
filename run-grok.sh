#!/usr/bin/env bash
cd "$(dirname "$0")"
grok -p "$(cat critic-prompt.txt)" --sandbox read-only --permission-mode dontAsk --disable-web-search --effort high --max-turns 60 < /dev/null > grok-r5.txt 2>&1
echo "grok exit=$?" >> grok-r5.txt
