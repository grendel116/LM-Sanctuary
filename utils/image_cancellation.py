import contextvars
from contextlib import contextmanager
import functools
import inspect
import os
import threading

_lock = threading.Lock()
_operations = set()
_current = contextvars.ContextVar("image_operation", default=None)


class ImageOperation:
    def __init__(self, session_id, program_id, kind, message_id=None, cancelled=None):
        self.session_id = session_id
        self.program_id = program_id
        self.kind = kind
        self.message_id = message_id
        self.cancelled = cancelled if cancelled is not None else threading.Event()
        self.finished = threading.Event()
        self.active = False
        self.temporary_files = []


def register_image_operation(func):
    signature = inspect.signature(func)
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        from tools.tools import current_session_id, current_speaker_id
        from runners.program import get_active_program
        arguments = signature.bind_partial(*args, **kwargs).arguments
        program_id = arguments.get("program_id") or current_speaker_id.get() or get_active_program()
        session_id = arguments.get("session_id") or current_session_id.get()
        parent = _current.get()
        operation = ImageOperation(
            session_id, program_id, func.__name__,
            message_id=parent.message_id if parent and parent.session_id == session_id else None,
            cancelled=parent.cancelled if parent and parent.session_id == session_id else None,
        )
        with _lock:
            _operations.add(operation)
        token = _current.set(operation)
        try:
            return func(*args, **kwargs)
        finally:
            _current.reset(token)
            try:
                for path in operation.temporary_files:
                    if os.path.exists(path):
                        os.remove(path)
            finally:
                with _lock:
                    _operations.discard(operation)
                    operation.finished.set()
    return wrapper


@contextmanager
def message_operation(session_id, message_id, program_id=None):
    operation = begin_message_operation(session_id, message_id, program_id)
    with use_message_operation(operation) as cancelled:
        yield cancelled


def begin_message_operation(session_id, message_id, program_id=None):
    operation = ImageOperation(session_id, program_id, "message_request", message_id=message_id)
    with _lock:
        _operations.add(operation)
    return operation


@contextmanager
def use_message_operation(operation):
    token = _current.set(operation)
    try:
        yield operation.cancelled
    finally:
        _current.reset(token)
        with _lock:
            _operations.discard(operation)
            operation.finished.set()


def activate_image_operation(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        operation = _current.get()
        from runners.runner import cancelled_sessions
        with _lock:
            if operation.cancelled.is_set() or operation.session_id in cancelled_sessions:
                if operation.kind == "generate_video_from_image":
                    raise RuntimeError("Video generation cancelled by user.")
                return "Error: Image generation cancelled by user."
            operation.active = True
        return func(*args, **kwargs)
    return wrapper


def current_event():
    operation = _current.get()
    return operation.cancelled if operation else None


def cleanup_on_completion(path):
    operation = _current.get()
    if operation is None:
        raise RuntimeError("Temporary image file has no registered operation.")
    operation.temporary_files.append(path)


def cancel(session_ids=(), program_id=None, timeout=30):
    return _cancel_matching(
        lambda operation: operation.session_id in session_ids or (program_id and operation.program_id == program_id),
        timeout,
    )


def cancel_message(session_id, message_id, timeout=30):
    return _cancel_matching(
        lambda operation: operation.session_id == session_id and operation.message_id == message_id,
        timeout,
    )


def _cancel_matching(matches, timeout):
    with _lock:
        operations = [operation for operation in _operations if matches(operation)]
        for operation in operations:
            operation.cancelled.set()
        active_kinds = {operation.kind for operation in operations if operation.active}
    if active_kinds.intersection({"generate_local_image", "apply_comfy_workflow"}):
        from core.engine_diffusion import unload_diffusion_models
        unload_diffusion_models()
    interrupt_error = None
    if "generate_video_from_image" in active_kinds:
        from variables.settings import COMFYUI_SERVER_URL
        import requests
        try:
            requests.post(f"{COMFYUI_SERVER_URL}/interrupt", timeout=1.0).raise_for_status()
        except requests.RequestException as exc:
            print(f"[CANCEL] ComfyUI interrupt unavailable: {exc}", flush=True)
            interrupt_error = exc
    for operation in operations:
        if not operation.finished.wait(timeout):
            raise RuntimeError("Image generation did not stop in time.")
    if interrupt_error:
        raise RuntimeError(f"Failed to interrupt ComfyUI: {interrupt_error}") from interrupt_error
    return bool(operations)
