#!/usr/bin/env python3
"""gh_watch_v2.py — post-reset delivery watcher (no login, no browser).

Polls `git ls-remote --heads origin` every 60s in /home/z/MOS-station.
Baseline captured at start; any new delivery branch or main-SHA change is
appended to /home/z/MOS-station/.watch/gh-events.jsonl and flagged in
.watch/new-delivery.marker. Detach via launch_detached pattern.
"""
import json
import os
import re
import subprocess
import time

REPO = "/home/z/MOS-station"
WATCH = os.path.join(REPO, ".watch")
EVENTS = os.path.join(WATCH, "gh-events.jsonl")
MARKER = os.path.join(WATCH, "new-delivery.marker")

os.makedirs(WATCH, exist_ok=True)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def ls_remote():
    out = subprocess.run(["git", "ls-remote", "--heads", "origin"],
                         cwd=REPO, capture_output=True, text=True, timeout=60)
    refs = {}
    for line in out.stdout.splitlines():
        m = re.match(r"([0-9a-f]{40})\s+refs/heads/(.+)", line.strip())
        if m:
            refs[m.group(2)] = m.group(1)
    return refs


def main():
    baseline = ls_remote()
    log("baseline:", len(baseline), "refs; main =", baseline.get("main", "?")[:10])
    seen = dict(baseline)
    while True:
        try:
            refs = ls_remote()
            for ref, sha in refs.items():
                if seen.get(ref) != sha:
                    kind = "new-branch" if ref not in seen else "branch-move"
                    with open(EVENTS, "a") as f:
                        f.write(json.dumps({"time": time.strftime("%Y-%m-%d %H:%M:%S"),
                                            "kind": kind, "ref": ref, "sha": sha,
                                            "was": seen.get(ref)}) + "\n")
                    with open(MARKER, "a") as f:
                        f.write(f"{kind} {ref} {sha[:10]}\n")
                    log(kind, ref, sha[:10])
            seen = refs
        except Exception as e:
            log("err", type(e).__name__, str(e)[:80])
        time.sleep(60)


if __name__ == "__main__":
    main()
