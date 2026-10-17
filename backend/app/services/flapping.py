"""Monitor state machine with flap protection.

Pure function, no I/O: the worker feeds it one check result at a time. A monitor goes
DOWN (and an incident opens) only after `failure_threshold` consecutive failures, and back
UP (the incident resolves) only after `recovery_threshold` consecutive successes. Anything
in between, like fail-fail-ok-fail-fail, keeps the current verdict.
"""

import enum
from dataclasses import dataclass

from app.models import MonitorStatus


class Action(enum.StrEnum):
    OPEN = "open"
    RESOLVE = "resolve"


@dataclass(frozen=True, slots=True)
class State:
    status: MonitorStatus
    failures: int = 0
    successes: int = 0


def step(state: State, ok: bool, *, failure_threshold: int, recovery_threshold: int) -> tuple[State, Action | None]:
    if ok:
        successes = state.successes + 1
        if state.status is MonitorStatus.DOWN:
            if successes >= recovery_threshold:
                return State(MonitorStatus.UP, 0, successes), Action.RESOLVE
            return State(MonitorStatus.DOWN, 0, successes), None
        return State(MonitorStatus.UP, 0, successes), None

    failures = state.failures + 1
    if state.status is not MonitorStatus.DOWN and failures >= failure_threshold:
        return State(MonitorStatus.DOWN, failures, 0), Action.OPEN
    return State(state.status, failures, 0), None
