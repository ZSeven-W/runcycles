from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import json
from pathlib import Path
from typing import Any
from uuid import uuid4

TWOPLACES = Decimal("0.01")
ZERO = Decimal("0.00")


def _quantize(value: Decimal | str | float | int) -> Decimal:
    decimal_value = value if isinstance(value, Decimal) else Decimal(str(value))
    return decimal_value.quantize(TWOPLACES, rounding=ROUND_HALF_UP)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class ReservationRecord:
    id: str
    run_id: str
    task: str
    requested: Decimal
    status: str
    created_at: str
    settled_at: str | None = None
    actual: Decimal | None = None
    reason: str | None = None

    def to_json(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["requested"] = f"{self.requested:.2f}"
        payload["actual"] = None if self.actual is None else f"{self.actual:.2f}"
        return payload


@dataclass(frozen=True)
class ReservationResult:
    id: str
    available_after: Decimal


@dataclass(frozen=True)
class RunSummary:
    run_id: str
    limit: Decimal
    committed_total: Decimal
    held_total: Decimal
    available: Decimal

    def to_json(self) -> dict[str, str]:
        return {
            "run_id": self.run_id,
            "limit": f"{self.limit:.2f}",
            "committed_total": f"{self.committed_total:.2f}",
            "held_total": f"{self.held_total:.2f}",
            "available": f"{self.available:.2f}",
        }


class BudgetLedger:
    def __init__(self, state_path: Path | str):
        self.state_path = Path(state_path)

    def reserve(self, run_id: str, task: str, limit: Decimal, requested: Decimal) -> ReservationResult:
        requested_amount = _quantize(requested)
        if requested_amount <= ZERO:
            raise ValueError("requested budget must be positive")

        state = self._load()
        run = self._ensure_run(state, run_id, _quantize(limit))
        summary = self._compute_summary(run)
        if requested_amount > summary.available:
            raise ValueError(
                f"requested budget exceeds remaining budget ({summary.available:.2f} available)"
            )

        reservation_id = str(uuid4())
        run["reservations"].append(
            ReservationRecord(
                id=reservation_id,
                run_id=run_id,
                task=task,
                requested=requested_amount,
                status="held",
                created_at=_utc_now(),
            ).to_json()
        )
        self._save(state)
        updated_summary = self._compute_summary(run)
        return ReservationResult(id=reservation_id, available_after=updated_summary.available)

    def commit(self, reservation_id: str, actual: Decimal) -> ReservationResult:
        actual_amount = _quantize(actual)
        if actual_amount < ZERO:
            raise ValueError("actual spend cannot be negative")

        state = self._load()
        run, reservation = self._find_reservation(state, reservation_id)
        if reservation["status"] != "held":
            raise ValueError("only held reservations can be committed")

        requested_amount = _quantize(reservation["requested"])
        if actual_amount > requested_amount:
            raise ValueError("actual spend cannot exceed reserved budget")

        reservation["status"] = "committed"
        reservation["actual"] = f"{actual_amount:.2f}"
        reservation["settled_at"] = _utc_now()
        self._save(state)
        summary = self._compute_summary(run)
        return ReservationResult(id=reservation_id, available_after=summary.available)

    def release(self, reservation_id: str, reason: str) -> ReservationResult:
        state = self._load()
        run, reservation = self._find_reservation(state, reservation_id)
        if reservation["status"] != "held":
            raise ValueError("only held reservations can be released")

        reservation["status"] = "released"
        reservation["reason"] = reason
        reservation["settled_at"] = _utc_now()
        self._save(state)
        summary = self._compute_summary(run)
        return ReservationResult(id=reservation_id, available_after=summary.available)

    def summary(self, run_id: str) -> RunSummary:
        state = self._load()
        runs = state.get("runs", {})
        if run_id not in runs:
            raise ValueError(f"unknown run_id: {run_id}")
        run = runs[run_id]
        return self._compute_summary(run, run_id)

    def _load(self) -> dict[str, Any]:
        if not self.state_path.exists():
            return {"runs": {}}
        return json.loads(self.state_path.read_text())

    def _save(self, state: dict[str, Any]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(json.dumps(state, indent=2, sort_keys=True))

    def _ensure_run(self, state: dict[str, Any], run_id: str, limit: Decimal) -> dict[str, Any]:
        runs = state.setdefault("runs", {})
        if run_id not in runs:
            runs[run_id] = {"limit": f"{limit:.2f}", "reservations": []}
        else:
            existing_limit = _quantize(runs[run_id]["limit"])
            if existing_limit != limit:
                raise ValueError(
                    f"run {run_id} already exists with limit {existing_limit:.2f}; received {limit:.2f}"
                )
        return runs[run_id]

    def _find_reservation(self, state: dict[str, Any], reservation_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        for run in state.get("runs", {}).values():
            for reservation in run.get("reservations", []):
                if reservation["id"] == reservation_id:
                    return run, reservation
        raise ValueError(f"unknown reservation id: {reservation_id}")

    def _compute_summary(self, run: dict[str, Any], run_id: str | None = None) -> RunSummary:
        limit = _quantize(run["limit"])
        held_total = ZERO
        committed_total = ZERO
        for reservation in run.get("reservations", []):
            requested = _quantize(reservation["requested"])
            status = reservation["status"]
            if status == "held":
                held_total += requested
            elif status == "committed":
                committed_total += _quantize(reservation["actual"])
        available = limit - held_total - committed_total
        return RunSummary(
            run_id=run_id or "unknown",
            limit=_quantize(limit),
            committed_total=_quantize(committed_total),
            held_total=_quantize(held_total),
            available=_quantize(available),
        )
