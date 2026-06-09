import os
import sys
import zipfile
from dotenv import load_dotenv

# Use directory of this script as workspace root and load active agent
workspace_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(workspace_dir, ".env"))

sys.path.insert(0, workspace_dir)
from utils.agent import get_active_agent

backups_dir = os.path.join(workspace_dir, "backups")
os.makedirs(backups_dir, exist_ok=True)

active_agent = get_active_agent()

# 1. backup_user.zip
# Specific configuration/state files
user_zip_path = os.path.join(backups_dir, "backup_user.zip")
user_files = [
    "variables/user.md",
    "variables/active_agent.txt",
    "variables/banned_words.json",
    ".env"
]
print("Creating backup_user.zip...")
with zipfile.ZipFile(user_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for f in user_files:
        abs_path = os.path.join(workspace_dir, f)
        if os.path.exists(abs_path):
            zipf.write(abs_path, f)

# 2. backup_agents.zip
# Everything specific to all agents (profile cards, databases, chat sessions, images, and portraits)
agents_zip_path = os.path.join(backups_dir, "backup_agents.zip")
agents_dir = os.path.normpath(os.path.join(workspace_dir, "core", "agents"))

print("Creating backup_agents.zip for all agents...")
with zipfile.ZipFile(agents_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    if os.path.exists(agents_dir):
        for root, dirs, files in os.walk(agents_dir):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for file in files:
                abs_path = os.path.join(root, file)
                rel_path = os.path.relpath(abs_path, workspace_dir)
                zipf.write(abs_path, rel_path)

# 3. backup_app.zip
# Everything in workspace, excluding virtual environment, git, backups, user-specific configs, and agent folders
app_zip_path = os.path.join(backups_dir, "backup_app.zip")
exclude_dirs = {".venv", ".git", "backups", "__pycache__", "agents"}
exclude_files = {".env", "user.md", "active_agent.txt", "banned_words.json"}
print("Creating backup_app.zip (clean codebase)...")
with zipfile.ZipFile(app_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for root, dirs, files in os.walk(workspace_dir):
        # Modify dirs in-place to prevent walking into excluded directories
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for file in files:
            # Check for user-specific file exclusions
            if file in exclude_files:
                rel_path = os.path.relpath(os.path.join(root, file), workspace_dir)
                # Normalize path separators for matching
                if rel_path.replace('\\', '/') in {
                    ".env",
                    "variables/user.md",
                    "variables/active_agent.txt",
                    "variables/banned_words.json"
                }:
                    continue
            abs_path = os.path.join(root, file)
            rel_path = os.path.relpath(abs_path, workspace_dir)
            zipf.write(abs_path, rel_path)

print("Backups completed successfully!")
