from decimal import Decimal
from pathlib import Path
import subprocess
import sys
import unittest

from runcycles.ledger import BudgetLedger


class BudgetLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.state_path = Path(__file__).parent / ".tmp-budget-state.json"
        if self.state_path.exists():
            self.state_path.unlink()
        self.ledger = BudgetLedger(self.state_path)

    def tearDown(self) -> None:
        if self.state_path.exists():
            self.state_path.unlink()

    def test_reserve_commit_and_release_flow_tracks_available_budget(self) -> None:
        reservation = self.ledger.reserve(
            run_id="run-123",
            task="triage failing CI",
            limit=Decimal("25.00"),
            requested=Decimal("7.50"),
        )

        self.assertEqual(Decimal("17.50"), reservation.available_after)

        committed = self.ledger.commit(
            reservation.id,
            actual=Decimal("5.25"),
        )

        self.assertEqual(Decimal("19.75"), committed.available_after)
        summary = self.ledger.summary("run-123")
        self.assertEqual(Decimal("25.00"), summary.limit)
        self.assertEqual(Decimal("5.25"), summary.committed_total)
        self.assertEqual(Decimal("0.00"), summary.held_total)
        self.assertEqual(Decimal("19.75"), summary.available)

    def test_rejects_reservation_that_exceeds_remaining_budget(self) -> None:
        self.ledger.reserve(
            run_id="run-999",
            task="first pass",
            limit=Decimal("10.00"),
            requested=Decimal("8.00"),
        )

        with self.assertRaisesRegex(ValueError, "remaining budget"):
            self.ledger.reserve(
                run_id="run-999",
                task="second pass",
                limit=Decimal("10.00"),
                requested=Decimal("3.00"),
            )

    def test_cancel_releases_held_budget_without_committing_spend(self) -> None:
        reservation = self.ledger.reserve(
            run_id="run-404",
            task="draft response",
            limit=Decimal("12.00"),
            requested=Decimal("4.00"),
        )

        released = self.ledger.release(reservation.id, reason="operator aborted")

        self.assertEqual(Decimal("12.00"), released.available_after)
        summary = self.ledger.summary("run-404")
        self.assertEqual(Decimal("0.00"), summary.committed_total)
        self.assertEqual(Decimal("0.00"), summary.held_total)
        self.assertEqual(Decimal("12.00"), summary.available)

    def test_cli_summary_reports_remaining_budget(self) -> None:
        reservation = self.ledger.reserve(
            run_id="run-cli",
            task="collect logs",
            limit=Decimal("15.00"),
            requested=Decimal("6.00"),
        )
        self.ledger.commit(reservation.id, actual=Decimal("4.00"))

        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "runcycles",
                "summary",
                "--state",
                str(self.state_path),
                "--run-id",
                "run-cli",
            ],
            capture_output=True,
            check=False,
            text=True,
            cwd=Path(__file__).resolve().parents[1],
        )

        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn('"available": "11.00"', result.stdout)
        self.assertIn('"committed_total": "4.00"', result.stdout)


if __name__ == "__main__":
    unittest.main()
