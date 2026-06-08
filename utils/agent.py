import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from variables import ACTIVE_AGENT_FILE

def get_active_agent() -> str:
    # Read from active_agent.txt with automatic default fallback if missing
    if not os.path.exists(ACTIVE_AGENT_FILE) or os.path.getsize(ACTIVE_AGENT_FILE) == 0:
        try:
            with open(ACTIVE_AGENT_FILE, "w", encoding="utf-8") as f:
                f.write("arthur")
        except Exception as e:
            print(f"Error creating default active agent file: {e}")
            return "arthur"

    with open(ACTIVE_AGENT_FILE, "r", encoding="utf-8") as f:
        val = f.read().strip()
        if not val:
            return "arthur"
        return val
