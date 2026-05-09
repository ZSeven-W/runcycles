from __future__ import annotations

import argparse
import json
from decimal import Decimal

from .ledger import BudgetLedger


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="RunCycles budget ledger CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    reserve = subparsers.add_parser("reserve", help="Reserve budget before a run step")
    reserve.add_argument("--state", required=True)
    reserve.add_argument("--run-id", required=True)
    reserve.add_argument("--task", required=True)
    reserve.add_argument("--limit", required=True)
    reserve.add_argument("--requested", required=True)

    commit = subparsers.add_parser("commit", help="Commit actual spend for a reservation")
    commit.add_argument("--state", required=True)
    commit.add_argument("--reservation", required=True)
    commit.add_argument("--actual", required=True)

    release = subparsers.add_parser("release", help="Release held budget for a reservation")
    release.add_argument("--state", required=True)
    release.add_argument("--reservation", required=True)
    release.add_argument("--reason", required=True)

    summary = subparsers.add_parser("summary", help="Print the current run budget summary")
    summary.add_argument("--state", required=True)
    summary.add_argument("--run-id", required=True)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    ledger = BudgetLedger(args.state)

    if args.command == "reserve":
        result = ledger.reserve(
            run_id=args.run_id,
            task=args.task,
            limit=Decimal(args.limit),
            requested=Decimal(args.requested),
        )
        print(json.dumps({"reservation_id": result.id, "available_after": f"{result.available_after:.2f}"}, indent=2))
        return 0

    if args.command == "commit":
        result = ledger.commit(args.reservation, actual=Decimal(args.actual))
        print(json.dumps({"reservation_id": result.id, "available_after": f"{result.available_after:.2f}"}, indent=2))
        return 0

    if args.command == "release":
        result = ledger.release(args.reservation, reason=args.reason)
        print(json.dumps({"reservation_id": result.id, "available_after": f"{result.available_after:.2f}"}, indent=2))
        return 0

    if args.command == "summary":
        print(json.dumps(ledger.summary(args.run_id).to_json(), indent=2))
        return 0

    parser.error(f"unsupported command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
