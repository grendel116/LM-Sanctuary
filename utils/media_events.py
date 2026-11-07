from collections.abc import Callable

_listener: Callable[[str | None], None] | None = None


def set_listener(listener: Callable[[str | None], None]) -> None:
    global _listener
    _listener = listener


def notify(program_id: str | None = None) -> None:
    if _listener is not None:
        _listener(program_id)
