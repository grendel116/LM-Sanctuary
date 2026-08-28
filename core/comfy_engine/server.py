"""
core/comfy_engine/server.py — Headless PromptServer stub for ComfyUI custom nodes.
"""

class DummyRoutes:
    def post(self, path):
        def decorator(func):
            return func
        return decorator

    def get(self, path):
        def decorator(func):
            return func
        return decorator


class PromptServer:
    instance = None

    def __init__(self):
        self.routes = DummyRoutes()
        self.client_id = None

    def send_sync(self, event, data, sid=None):
        pass

    def add_on_prompt_handler(self, handler):
        pass


PromptServer.instance = PromptServer()
