#!/usr/bin/env python3
"""Compare an environment snapshot with a customer-approved compatibility matrix."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class MatrixError(ValueError):
    pass


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MatrixError(f"Cannot read valid JSON from {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise MatrixError(f"{path} must contain a JSON object")
    return value


def validate_matrix(matrix: dict[str, Any]) -> list[dict[str, Any]]:
    if matrix.get("schema_version") != 1:
        raise MatrixError("Compatibility matrix schema_version must be 1")
    checks = matrix.get("checks")
    if not isinstance(checks, list):
        raise MatrixError("Compatibility matrix 'checks' must be an array")

    seen: set[str] = set()
    for index, check in enumerate(checks):
        if not isinstance(check, dict):
            raise MatrixError(f"checks[{index}] must be an object")
        check_id = check.get("id")
        field = check.get("field")
        operator = check.get("operator")
        if not isinstance(check_id, str) or not check_id.strip():
            raise MatrixError(f"checks[{index}].id must be a non-empty string")
        if check_id in seen:
            raise MatrixError(f"Duplicate check id: {check_id}")
        seen.add(check_id)
        if not isinstance(field, str) or not field.strip():
            raise MatrixError(f"checks[{index}].field must be a non-empty dotted path")
        if operator not in {"equals", "one_of", "exists"}:
            raise MatrixError(f"Unsupported operator in check '{check_id}'")
        if operator == "equals" and "expected" not in check:
            raise MatrixError(f"Check '{check_id}' requires expected")
        if operator == "one_of" and (
            not isinstance(check.get("expected"), list) or not check["expected"]
        ):
            raise MatrixError(f"Check '{check_id}' requires a non-empty expected array")
    return checks


def lookup_path(document: dict[str, Any], dotted_path: str) -> tuple[bool, Any]:
    current: Any = document
    for segment in dotted_path.split("."):
        if not isinstance(current, dict) or segment not in current:
            return False, None
        current = current[segment]
    return True, current


def evaluate_check(snapshot: dict[str, Any], check: dict[str, Any]) -> dict[str, Any]:
    found, actual = lookup_path(snapshot, check["field"])
    operator = check["operator"]
    if operator == "exists":
        status = "supported" if found and actual not in (None, "") else "unavailable"
    elif not found or actual is None or actual == "":
        status = "unavailable"
    elif operator == "equals":
        status = "supported" if actual == check["expected"] else "unsupported"
    else:  # one_of
        status = "supported" if actual in check["expected"] else "unsupported"

    result: dict[str, Any] = {
        "id": check["id"],
        "field": check["field"],
        "operator": operator,
        "status": status,
    }
    if found:
        result["actual"] = actual
    if operator != "exists":
        result["expected"] = check["expected"]
    if check.get("description"):
        result["description"] = check["description"]
    return result


def compare(snapshot: dict[str, Any], matrix: dict[str, Any]) -> dict[str, Any]:
    checks = validate_matrix(matrix)
    results = [evaluate_check(snapshot, check) for check in checks]
    counts = {
        status: sum(1 for result in results if result["status"] == status)
        for status in ("supported", "unsupported", "unavailable")
    }
    return {
        "report_schema_version": 1,
        "comparison_type": "environment-compatibility",
        "compared_at_utc": datetime.now(timezone.utc).isoformat(),
        "matrix_id": matrix.get("matrix_id", "unnamed"),
        "matrix_version": matrix.get("matrix_version", "unspecified"),
        "snapshot_schema_version": snapshot.get("schema_version"),
        "overall_status": (
            "unsupported" if counts["unsupported"] else
            "incomplete" if counts["unavailable"] else "supported"
        ),
        "counts": counts,
        "results": results,
        "disclaimer": "Results reflect only the supplied matrix; they do not certify a platform.",
    }


def write_json_atomic(document: dict[str, Any], destination: Path) -> None:
    temporary = destination.with_name(destination.name + ".tmp")
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        temporary.replace(destination)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise MatrixError(f"Cannot write report to {destination}: {exc}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compare an environment snapshot with an approved compatibility matrix."
    )
    parser.add_argument("snapshot", type=Path, help="Environment snapshot JSON")
    parser.add_argument("matrix", type=Path, help="Approved compatibility matrix JSON")
    parser.add_argument("-o", "--output", type=Path, default=Path("compatibility-report.json"))
    args = parser.parse_args(argv)
    try:
        report = compare(load_json(args.snapshot), load_json(args.matrix))
        write_json_atomic(report, args.output)
        print(f"Compatibility report written: {args.output} ({report['overall_status']})")
        return 0 if report["overall_status"] == "supported" else 2
    except MatrixError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
