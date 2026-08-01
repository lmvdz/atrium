#!/usr/bin/env python3
"""Mechanical provenance/validity checks over spike runs.

Judgement of semantic correctness is mine (see ground-truth.md and the scorecards);
this script only checks the things a machine can check without opinion:
  - is the output parseable JSON, and only JSON?
  - does every cited message_id exist in the window?
  - does the `quote` appear verbatim in a cited message?
  - does it still appear once GitHub reply-blockquotes (`> ...`) are stripped?
    (a quote that only survives with blockquotes intact is text the cited author
     did not write — they were quoting someone else)
  - for Claims/Commitments, is the named claimant/owner the author of a cited message?
"""
import json, re, sys, pathlib

BASE = pathlib.Path(__file__).resolve().parent


def load_window(name):
    txt = (BASE / f"window-{name}.txt").read_text()
    msgs = {}
    for chunk in re.split(r"^--- message_id: ", txt, flags=re.M)[1:]:
        head, body = chunk.split("---", 1)
        mid, author, ts = [p.strip() for p in head.split("|")]
        msgs[mid] = {
            "author": author.replace("author:", "").strip(),
            "text": body,
            "own": "\n".join(l for l in body.splitlines() if not l.lstrip().startswith(">")),
        }
    return msgs


def norm(s):
    return re.sub(r"[\s*_`]+", " ", s).strip().lower()


def check(label, window):
    raw = (BASE / "runs" / f"{label}.last.txt").read_text().strip()
    msgs = load_window(window)
    r = {"label": label, "window": window, "json_valid": True, "json_clean": not raw.startswith("```")}
    try:
        doc = json.loads(raw)
    except Exception as e:
        r["json_valid"] = False
        r["error"] = str(e)
        return r
    objs = doc.get("objects", [])
    r["n_objects"] = len(objs)
    r["n_relations"] = len(doc.get("relations", []))
    counts, bad_id, quote_miss, quote_only_in_blockquote, wrong_author, no_conf = {}, [], [], [], [], []
    for o in objs:
        counts[o.get("type", "?")] = counts.get(o.get("type", "?"), 0) + 1
        if not isinstance(o.get("confidence"), (int, float)):
            no_conf.append(o.get("id"))
        prov = o.get("provenance") or []
        for p in prov:
            if p not in msgs:
                bad_id.append((o.get("id"), p))
        q = norm(o.get("quote", ""))
        cited = [msgs[p] for p in prov if p in msgs]
        if q and cited:
            if not any(q in norm(m["text"]) for m in cited):
                quote_miss.append((o.get("id"), o.get("quote", "")[:60]))
            elif not any(q in norm(m["own"]) for m in cited):
                quote_only_in_blockquote.append((o.get("id"), o.get("quote", "")[:60]))
        who = o.get("claimant") or o.get("owner")
        if who and cited and not any(m["author"] == who for m in cited):
            wrong_author.append((o.get("id"), who, [m["author"] for m in cited]))
    r.update(type_counts=counts, bad_message_ids=bad_id, quote_not_found=quote_miss,
             quote_only_in_reply_blockquote=quote_only_in_blockquote,
             attributed_person_not_author_of_any_cited_msg=wrong_author,
             missing_confidence=no_conf)
    return r


if __name__ == "__main__":
    runs = [("luna-A-r1", "A"), ("luna-A-r2", "A"), ("terra-A", "A"),
            ("luna-B-r1", "B"), ("terra-B", "B"), ("luna-B-ctx", "B")]
    out = []
    for label, w in runs:
        if (BASE / "runs" / f"{label}.last.txt").exists():
            out.append(check(label, w))
    print(json.dumps(out, indent=2))
