import os
import sys
import zipfile
from dotenv import load_dotenv

# Use directory of this script as workspace root
workspace_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(workspace_dir, ".env"))

backups_dir = os.path.join(workspace_dir, "backups")
os.makedirs(backups_dir, exist_ok=True)

# Helper function to recursively add directories to a zipfile
def zip_dir(src_dir, zip_handle, exclude_names=None):
    if exclude_names is None:
        exclude_names = set()
    for root, dirs, files in os.walk(src_dir):
        # Modify dirs in-place to skip excluded directories
        dirs[:] = [d for d in dirs if d not in exclude_names]
        for file in files:
            if file in exclude_names:
                continue
            abs_path = os.path.join(root, file)
            rel_path = os.path.relpath(abs_path, workspace_dir)
            zip_handle.write(abs_path, rel_path)

# 1. backup_user.zip
# User configuration, custom variables/profiles, and TLS certificates
user_zip_path = os.path.join(backups_dir, "backup_user.zip")
print("Creating backup_user.zip (User settings, variables, and certificates)...")
with zipfile.ZipFile(user_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    # Backup .env
    env_path = os.path.join(workspace_dir, ".env")
    if os.path.exists(env_path):
        zipf.write(env_path, ".env")
    
    # Backup variables directory
    variables_dir = os.path.join(workspace_dir, "variables")
    if os.path.exists(variables_dir):
        zip_dir(variables_dir, zipf, exclude_names={"__pycache__"})
        
    # Backup certs directory
    certs_dir = os.path.join(workspace_dir, "certs")
    if os.path.exists(certs_dir):
        zip_dir(certs_dir, zipf, exclude_names={"__pycache__"})

# 2. backup_programs.zip
# Everything specific to companion programs/sessions (databank, profiles, journals, media, portraits, memories)
programs_zip_path = os.path.join(backups_dir, "backup_programs.zip")
programs_dir = os.path.normpath(os.path.join(workspace_dir, "core", "programs"))
print("Creating backup_programs.zip (Companion programs and user chat data)...")
with zipfile.ZipFile(programs_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    if os.path.exists(programs_dir):
        zip_dir(programs_dir, zipf, exclude_names={"__pycache__"})

# 3. backup_models.zip
# Downloaded speech and offline AI models so user does not need to re-download
models_zip_path = os.path.join(backups_dir, "backup_models.zip")
speech_model_dir = os.path.join(workspace_dir, "core", "skills", "speech_generation", "speech_model")
print("Creating backup_models.zip (TTS speech models)...")
with zipfile.ZipFile(models_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    if os.path.exists(speech_model_dir):
        zip_dir(speech_model_dir, zipf, exclude_names={"__pycache__"})

# 4. backup_app.zip
# Source code of the app only, excluding venv, git, certs, backups, settings, databases, and large model assets
app_zip_path = os.path.join(backups_dir, "backup_app.zip")
exclude_dirs = {
    ".venv", 
    ".git", 
    "backups", 
    "__pycache__", 
    "programs", 
    "certs", 
    "variables",
    "speech_model", 
    "speech_cache"
}
exclude_files = {
    ".env", 
    "comfy_server.log"
}
print("Creating backup_app.zip (Codebase only)...")
with zipfile.ZipFile(app_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for root, dirs, files in os.walk(workspace_dir):
        # Modify dirs in-place to prevent walking into excluded directories
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for file in files:
            if file in exclude_files or file.endswith(".log"):
                continue
            abs_path = os.path.join(root, file)
            rel_path = os.path.relpath(abs_path, workspace_dir)
            zipf.write(abs_path, rel_path)

print("Backups completed successfully!")
print("\n" + "="*60)
print("IMPORTANT WARNING:")
print("If you plan to erase the workspace directory, copy/move")
print(f"the entire '{backups_dir}' folder to a safe location OUTSIDE")
print("of this workspace FIRST! Otherwise, your backup files will be deleted!")
print("="*60 + "\n")

