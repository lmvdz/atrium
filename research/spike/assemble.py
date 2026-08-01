#!/usr/bin/env python3
"""Rebuild the exact prompts that were sent, and re-cut the windows from the corpus.

    python3 assemble.py windows   # regenerate window-A.txt / window-B.txt from corpora/ts9998.jsonl
    python3 assemble.py prompts   # write prompt-window-{A,B,B-ctx}.txt

Run order used in the spike (all via codex, read-only, window inlined, no --output-schema):

    codex exec -m gpt-5.6-luna  -s read-only - < prompt-window-A.txt
    codex exec -m gpt-5.6-luna  -s read-only - < prompt-window-A.txt      # repeat, stability
    codex exec -m gpt-5.6-terra -s read-only - < prompt-window-A.txt
    codex exec -m gpt-5.6-luna  -s read-only - < prompt-window-B.txt
    codex exec -m gpt-5.6-terra -s read-only - < prompt-window-B.txt
    codex exec -m gpt-5.6-luna  -s read-only - < prompt-window-B-ctx.txt
"""
import json, pathlib, sys

BASE = pathlib.Path(__file__).resolve().parent
CORPUS = BASE.parent.parent / "corpora" / "ts9998.jsonl"
WINDOWS = {"A": (0, 20), "B": (90, 111)}


def cut_windows():
    rows = [json.loads(l) for l in CORPUS.open()]
    for name, (a, b) in WINDOWS.items():
        chunks = [
            "--- message_id: %s | author: %s | timestamp: %s ---\n%s" % (r["id"], r["author"], r["ts"], r["text"])
            for r in rows[a:b]
        ]
        (BASE / f"window-{name}.txt").write_text("\n\n".join(chunks))
        print(f"window-{name}.txt  messages {a}..{b - 1}")


def build_prompts():
    header = (BASE / "prompt-header.txt").read_text()
    for name in ("A", "B"):
        body = (BASE / f"window-{name}.txt").read_text()
        (BASE / f"prompt-window-{name}.txt").write_text(
            f"{header}=== BEGIN WINDOW {name} ===\n\n{body}\n\n=== END WINDOW {name} ===\n")
    acc = (BASE / "accepted-state.txt").read_text()
    ctx_header = header.replace("Now extract from this window.\n", acc + "\nNow extract from this window.\n")
    body = (BASE / "window-B.txt").read_text()
    (BASE / "prompt-window-B-ctx.txt").write_text(
        f"{ctx_header}=== BEGIN WINDOW B ===\n\n{body}\n\n=== END WINDOW B ===\n")
    print("prompt-window-A.txt, prompt-window-B.txt, prompt-window-B-ctx.txt")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "prompts"
    (cut_windows if what == "windows" else build_prompts)()
