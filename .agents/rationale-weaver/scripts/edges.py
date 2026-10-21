#!/usr/bin/env python3
"""Deterministic operations on a TreeOfDeductions rationale edge store.

The store is a JSON document `{"edges": [...]}` where each edge is
`{"from": {"file", "lines"}, "to": {"file", "lines"}, "rationale"}`.
Lines are 1-based inclusive; endpoint paths are relative to the project
root that owns the store (the parent of `.treeofdeductions/`).

Commands:
  list [--file FILE] [--side from|to]  edges in the store, as JSON (indices are
                                        the edge's position in the current array)
  validate [--strict]                  schema errors + drift warnings (missing
                                        files, out-of-bounds ranges, duplicates);
                                        --strict fails on warnings too
  apply OPS_JSON                       apply add/update/remove ops atomically;
                                        indices refer to the current array exactly
                                        as reported by `list`

--store PATH (before the subcommand) targets a specific rationale.json;
otherwise the store is found by walking up from the cwd, then searching
below it (node_modules excluded).
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

STORE_DIR = ".treeofdeductions"
STORE_FILE = "rationale.json"


def fail(message: str) -> None:
    print(json.dumps({"error": message}, ensure_ascii=False))
    sys.exit(1)


def find_store(explicit: str | None, start: Path) -> Path:
    if explicit:
        path = Path(explicit)
        if path.is_file():
            return path
        fail(f"--store {explicit} does not exist")
    for directory in [start, *start.parents]:
        candidate = directory / STORE_DIR / STORE_FILE
        if candidate.is_file():
            return candidate
    matches = [
        p for p in start.rglob(f"{STORE_DIR}/{STORE_FILE}")
        if "node_modules" not in p.parts
    ]
    if not matches:
        fail(f"no {STORE_DIR}/{STORE_FILE} found at or below {start}")
    return sorted(matches)[0]


def load_edges(store: Path) -> list:
    try:
        document = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot parse {store}: {error}")
    edges = document.get("edges") if isinstance(document, dict) else None
    if not isinstance(edges, list):
        fail(f'{store} has no "edges" array')
    return edges


def base_of(store: Path) -> Path:
    return store.parent.parent


def normalize(path: str) -> str:
    return path.replace(os.sep, "/")


def endpoint_problem(value, name: str) -> str | None:
    if not isinstance(value, dict):
        return f"{name} must be an object"
    file = value.get("file")
    if not isinstance(file, str) or not file.strip():
        return f"{name}.file must be a non-empty string"
    lines = value.get("lines")
    if (
        not isinstance(lines, list) or len(lines) != 2
        or not all(isinstance(n, int) and not isinstance(n, bool) for n in lines)
        or lines[0] < 1 or lines[1] < lines[0]
    ):
        return f"{name}.lines must be two integers [start, end], 1 <= start <= end"
    return None


def edge_problem(edge) -> str | None:
    if not isinstance(edge, dict):
        return "edge must be an object"
    for side in ("from", "to"):
        problem = endpoint_problem(edge.get(side), side)
        if problem:
            return problem
    rationale = edge.get("rationale")
    if not isinstance(rationale, str) or not rationale.strip():
        return "rationale must be a non-empty string"
    return None


def file_matches(query: str, edge_file: str) -> bool:
    q, f = normalize(query).lstrip("./"), normalize(edge_file).lstrip("./")
    return q == f or f.endswith("/" + q) or q.endswith("/" + f)


def cmd_list(args) -> None:
    store = find_store(args.store, Path.cwd())
    edges = load_edges(store)
    target = normalize(args.file).lstrip("./") if args.file else None
    rows = []
    for index, edge in enumerate(edges):
        if edge_problem(edge):
            continue  # `validate` reports these; `list` stays useful mid-breakage
        sides = []
        if target:
            if args.side in (None, "from") and file_matches(target, edge["from"]["file"]):
                sides.append("from")
            if args.side in (None, "to") and file_matches(target, edge["to"]["file"]):
                sides.append("to")
            if not sides:
                continue
        rows.append({
            "index": index,
            "sides": sides or ["from", "to"],
            "from": edge["from"],
            "to": edge["to"],
            "rationale": edge["rationale"],
        })
    print(json.dumps({"store": str(store), "count": len(rows), "edges": rows},
                     ensure_ascii=False, indent=2))


def cmd_validate(args) -> None:
    store = find_store(args.store, Path.cwd())
    edges = load_edges(store)
    base = base_of(store)
    problems = []
    seen = {}
    for index, edge in enumerate(edges):
        problem = edge_problem(edge)
        if problem:
            problems.append({"index": index, "kind": "schema", "detail": problem})
            continue
        key = json.dumps([edge["from"], edge["to"], edge["rationale"]], ensure_ascii=False)
        if key in seen:
            problems.append({"index": index, "kind": "duplicate",
                             "detail": f"exact duplicate of edges[{seen[key]}]"})
        seen[key] = index
        for side in ("from", "to"):
            path = base / edge[side]["file"]
            if not path.is_file():
                problems.append({"index": index, "kind": "missing-file",
                                 "detail": f"{side}.file does not exist: {edge[side]['file']}"})
                continue
            try:
                line_count = sum(1 for _ in path.open(encoding="utf-8", errors="replace"))
            except OSError:
                continue
            end = edge[side]["lines"][1]
            if end > line_count:
                problems.append({"index": index, "kind": "out-of-bounds",
                                 "detail": f"{side}.lines end {end} beyond {edge[side]['file']} ({line_count} lines) — likely drift"})
    schema = [p for p in problems if p["kind"] == "schema"]
    report = {"store": str(store), "edges": len(edges), "schema_errors": len(schema),
              "warnings": len(problems) - len(schema), "problems": problems}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    failing = problems if args.strict else schema
    sys.exit(1 if failing else 0)


def cmd_apply(args) -> None:
    store = find_store(args.store, Path.cwd())
    edges = load_edges(store)
    try:
        ops = json.loads(Path(args.ops).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read ops file {args.ops}: {error}")
    if not isinstance(ops, dict) or not isinstance(ops.get("ops"), list):
        fail('ops file must be {"ops": [...]}')

    adds, changes = [], []
    for position, op in enumerate(ops["ops"]):
        kind = op.get("op") if isinstance(op, dict) else None
        if kind == "add":
            problem = edge_problem(op.get("edge"))
            if problem:
                fail(f"ops[{position}]: add: {problem}")
            adds.append(op["edge"])
        elif kind == "update":
            index, edge = op.get("index"), op.get("edge")
            problem = edge_problem(edge)
            if problem:
                fail(f"ops[{position}]: update: {problem}")
            if not isinstance(index, int) or not 0 <= index < len(edges):
                fail(f"ops[{position}]: update: index {index!r} out of range 0..{len(edges) - 1}")
            changes.append(("update", index, edge))
        elif kind == "remove":
            index = op.get("index")
            if not isinstance(index, int) or not 0 <= index < len(edges):
                fail(f"ops[{position}]: remove: index {index!r} out of range 0..{len(edges) - 1}")
            changes.append(("remove", index, None))
        else:
            fail(f'ops[{position}]: op must be "add", "update", or "remove"')

    # Indices refer to the array as `list` reported it, so mutate from the end
    # down — earlier indices stay valid — then append the adds.
    touched = set()
    for kind, index, edge in sorted(changes, key=lambda c: c[1], reverse=True):
        if index in touched:
            fail(f"multiple ops target edges[{index}]; merge them into one op")
        touched.add(index)
        if kind == "remove":
            del edges[index]
        else:
            edges[index] = edge
    edges.extend(adds)

    # Atomic write: temp file in the same directory, then rename over the store.
    # ensure_ascii=False + indent 4 match the hand-maintained store format.
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=store.parent,
                                     prefix=STORE_FILE, suffix=".tmp",
                                     delete=False) as handle:
        json.dump({"edges": edges}, handle, ensure_ascii=False, indent=4)
        handle.write("\n")
        temp = Path(handle.name)
    os.replace(temp, store)
    print(json.dumps({"store": str(store), "added": len(adds),
                      "updated": sum(1 for k, _, _ in changes if k == "update"),
                      "removed": sum(1 for k, _, _ in changes if k == "remove"),
                      "total": len(edges)}, ensure_ascii=False, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--store", help=f"path to a {STORE_DIR}/{STORE_FILE}")
    sub = parser.add_subparsers(required=True)
    listing = sub.add_parser("list", help="edges in the store, optionally filtered")
    listing.add_argument("--file", help="only edges touching this file (either side)")
    listing.add_argument("--side", choices=["from", "to"])
    listing.set_defaults(func=cmd_list)
    validating = sub.add_parser("validate", help="schema errors + drift warnings")
    validating.add_argument("--strict", action="store_true", help="also fail on warnings")
    validating.set_defaults(func=cmd_validate)
    applying = sub.add_parser("apply", help="apply add/update/remove ops atomically")
    applying.add_argument("ops", help="path to a {\"ops\": [...]} JSON file")
    applying.set_defaults(func=cmd_apply)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
