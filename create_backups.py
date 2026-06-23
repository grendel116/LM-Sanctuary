import os
import sys
import zipfile

# Use directory of this script as workspace root
workspace_dir = os.path.dirname(os.path.abspath(__file__))

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
        
    # Backup portrait generation skill folder (contains custom workflow files)
    portrait_gen_dir = os.path.join(workspace_dir, "core", "skills", "portrait_generation")
    if os.path.exists(portrait_gen_dir):
        zip_dir(portrait_gen_dir, zipf, exclude_names={"__pycache__"})

# 2. backup_programs.zip
# Everything specific to companion programs/sessions (databank, profiles, journals, media, portraits, memories)
programs_zip_path = os.path.join(backups_dir, "backup_programs.zip")
programs_dir = os.path.normpath(os.path.join(workspace_dir, "core", "programs"))
print("Creating backup_programs.zip (Companion programs and user chat data)...")
with zipfile.ZipFile(programs_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    if os.path.exists(programs_dir):
        zip_dir(programs_dir, zipf, exclude_names={"__pycache__"})

# 3. backup_app.zip
# Source code only, mirroring exactly what is tracked in git
app_zip_path = os.path.join(backups_dir, "backup_app.zip")
print("Creating backup_app.zip (Git tracked codebase)...")
import subprocess
result = subprocess.run(
    ["git", "ls-files"],
    cwd=workspace_dir, capture_output=True, text=True
)
tracked_files = [f for f in result.stdout.strip().splitlines() if f]
with zipfile.ZipFile(app_zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
    for rel_path in tracked_files:
        abs_path = os.path.join(workspace_dir, rel_path)
        if os.path.exists(abs_path):
            zipf.write(abs_path, rel_path)

print("Backups completed successfully!")
print("\n" + "="*60)
print("IMPORTANT WARNING:")
print("If you plan to erase the workspace directory, copy/move")
print(f"the entire '{backups_dir}' folder to a safe location OUTSIDE")
print("of this workspace FIRST! Otherwise, your backup files will be deleted!")
print("="*60 + "\n")

