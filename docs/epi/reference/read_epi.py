"""Read the basic queries from an .epi v2 knowledge projection."""

import argparse
import json
from pathlib import Path
import re
import sys


def fields(value, name: str, **required: type) -> dict:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object")
    for key, expected in required.items():
        if not isinstance(value.get(key), expected):
            raise ValueError(f"{name}.{key} must be a {expected.__name__}")
    return value


def check_timestamp(value: str, name: str) -> None:
    utc_pattern = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z"
    if not re.fullmatch(utc_pattern, value):
        raise ValueError(f"{name} must be an ISO 8601 UTC timestamp")


def reject_constant(token: str) -> None:
    raise ValueError(f"invalid JSON constant {token}")


def read_epi(path: Path) -> dict:
    with path.open(encoding="utf-8") as stream:
        document = json.load(stream, parse_constant=reject_constant)

    # Check the envelope and the shapes these queries rely on, not the full JSON Schema.
    # The checksum fields are metadata here; hash verification and archive replay are separate.
    file = fields(document, "file", exportedAt=str, source=dict, profiles=list)
    if file.get("format") != "episteme-knowledge":
        raise ValueError("expected format episteme-knowledge")
    if file.get("version") != 2:
        raise ValueError("expected .epi version 2")
    check_timestamp(file["exportedAt"], "exportedAt")
    fields(file["source"], "source", file=str, build=str)
    profiles = file["profiles"]
    if (
        not profiles
        or any(profile not in ("archive", "knowledge") for profile in profiles)
        or len(set(profiles)) != len(profiles)
    ):
        raise ValueError("profiles must list archive and/or knowledge once each")
    if "archive" in profiles:
        fields(file.get("archive"), "archive", history=dict)

    result = {"nodesByType": {}, "relations": [], "states": {}, "publications": []}
    if "knowledge" not in profiles:
        return result

    fields(file.get("ontology"), "ontology", packs=list, sha256=str)
    knowledge = fields(
        file.get("knowledge"),
        "knowledge",
        derivedFrom=dict,
        derivedAt=str,
        nodes=list,
        edges=list,
        branches=list,
        state=list,
        publications=list,
        sources=list,
        sha256=str,
    )
    check_timestamp(knowledge["derivedAt"], "knowledge.derivedAt")
    receipt = fields(
        knowledge["derivedFrom"], "knowledge.derivedFrom", ontologySha256=str, filter=dict
    )
    if "historySha256" in receipt:
        fields(receipt, "knowledge.derivedFrom", historySha256=str)

    for node in knowledge["nodes"]:
        fields(node, "knowledge.nodes entry", id=str, type=str)
        result["nodesByType"].setdefault(node["type"], []).append(node["id"])

    for edge in knowledge["edges"]:
        fields(edge, "knowledge.edges entry", id=str, to=str, type=str, **{"from": str})
        result["relations"].append({key: edge[key] for key in ("from", "to", "type")})

    for entry in knowledge["state"]:
        fields(entry, "knowledge.state entry", target=str, actor=str, dimensions=dict)
        result["states"].setdefault(entry["actor"], []).append(
            {"target": entry["target"], "dimensions": entry["dimensions"]}
        )

    result["publications"] = knowledge["publications"]
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(read_epi(args.file), allow_nan=False))
    except (OSError, ValueError, RecursionError) as error:
        print(f"read_epi: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
