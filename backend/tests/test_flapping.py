import pytest

from app.models import MonitorStatus
from app.services.flapping import Action, State, step

UP, DOWN, PENDING = MonitorStatus.UP, MonitorStatus.DOWN, MonitorStatus.PENDING


def run(sequence: str, status: MonitorStatus = UP, failure_threshold: int = 3, recovery_threshold: int = 2):
    """Feed a string of checks ('x' = fail, '.' = ok); return final status and the actions taken."""
    state, actions = State(status), []
    for char in sequence:
        state, action = step(
            state, char == ".", failure_threshold=failure_threshold, recovery_threshold=recovery_threshold
        )
        if action:
            actions.append(action)
    return state.status, actions


@pytest.mark.parametrize(
    ("sequence", "status", "actions"),
    [
        ("xx", UP, []),
        ("xxx", DOWN, [Action.OPEN]),
        ("xxxxxx", DOWN, [Action.OPEN]),  # one incident, not one per failure
        ("xx.xx", UP, []),  # flapping never reaches the threshold
        ("xxx.", DOWN, [Action.OPEN]),  # one success is not a recovery
        ("xxx..", UP, [Action.OPEN, Action.RESOLVE]),
        ("xxx.x..", UP, [Action.OPEN, Action.RESOLVE]),  # a failure resets the recovery streak
        ("xxx.x.", DOWN, [Action.OPEN]),
        ("xxx..xxx..", UP, [Action.OPEN, Action.RESOLVE, Action.OPEN, Action.RESOLVE]),
    ],
)
def test_thresholds(sequence, status, actions):
    assert run(sequence) == (status, actions)


def test_new_monitor_stays_pending_until_a_verdict():
    assert run("xx", PENDING) == (PENDING, [])
    assert run(".", PENDING) == (UP, [])
    assert run("xxx", PENDING) == (DOWN, [Action.OPEN])


def test_threshold_of_one_reacts_immediately():
    assert run("x.", failure_threshold=1, recovery_threshold=1) == (UP, [Action.OPEN, Action.RESOLVE])


def test_counters():
    state, _ = step(State(UP, 2, 0), False, failure_threshold=5, recovery_threshold=2)
    assert (state.failures, state.successes) == (3, 0)
    state, _ = step(state, True, failure_threshold=5, recovery_threshold=2)
    assert (state.failures, state.successes) == (0, 1)
