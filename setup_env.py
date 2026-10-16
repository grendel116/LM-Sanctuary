"""
setup_env.py — Hardware-aware environment bootstrapper and dependency installer for LM-Sanctuary.

Uses only Python standard library modules at startup so it can execute inside a brand-new
virtual environment before any third-party packages are installed.
"""

import glob
import hashlib
import importlib.util
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
REQUIREMENTS_FILE = BASE_DIR / "requirements.txt"
ENV_FILE = BASE_DIR / ".env"
ENV_EXAMPLE_FILE = BASE_DIR / ".env.example"
STAMP_FILE = Path(sys.prefix) / ".sanctuary_install_stamp"

REQUIRED_IMPORT_SPECS = (
    "flask",
    "dotenv",
    "sentence_transformers",
    "kokoro_onnx",
    "soundfile",
    "bs4",
    "requests",
    "httpx",
    "primp",
    "PIL",
    "numpy",
    "OpenSSL",
    "cryptography",
    "psutil",
    "markdownify",
    "pypdf",
    "docx",
    "openpyxl",
    "ddgs",
    "musicbrainzngs",
    "webview",
    "faster_whisper",
    "torch",
    "torchvision",
    "torchaudio",
    "transformers",
    "diffusers",
    "safetensors",
    "accelerate",
    "einops",
    "torchsde",
    "scipy",
    "kornia",
    "aiohttp",
    "yaml",
    "tqdm",
)


def detect_gpu_vendor() -> str:
    """Detects GPU vendor ('nvidia', 'amd', 'intel', 'apple', or 'cpu')."""
    if sys.platform == "darwin":
        return "apple"

    if os.name == "nt":
        try:
            out = subprocess.check_output(
                'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
                shell=True,
                text=True,
                stderr=subprocess.DEVNULL,
                timeout=5.0,
            ).lower()
            if "nvidia" in out:
                return "nvidia"
            if "amd" in out or "radeon" in out:
                return "amd"
            if "intel" in out or "arc" in out:
                return "intel"
        except Exception:
            pass

    try:
        subprocess.check_output(["nvidia-smi"], stderr=subprocess.DEVNULL, timeout=3.0)
        return "nvidia"
    except Exception:
        pass

    return "cpu"


def ensure_directories_and_env() -> None:
    """Creates required runtime directories and seeds .env from .env.example if missing."""
    required_dirs = [
        BASE_DIR / "models" / "llm",
        BASE_DIR / "models" / "checkpoints",
        BASE_DIR / "models" / "loras",
        BASE_DIR / "models" / "vae",
        BASE_DIR / "models" / "ultralytics" / "bbox",
        BASE_DIR / "logs",
        BASE_DIR / "certs",
    ]
    for d in required_dirs:
        d.mkdir(parents=True, exist_ok=True)

    if not ENV_FILE.exists() and ENV_EXAMPLE_FILE.exists():
        shutil.copy(ENV_EXAMPLE_FILE, ENV_FILE)
        print("[Setup] Created default .env configuration from .env.example")


def compute_req_digest() -> str:
    """Computes a short SHA-256 digest of requirements.txt."""
    req_bytes = REQUIREMENTS_FILE.read_bytes() if REQUIREMENTS_FILE.exists() else b""
    return hashlib.sha256(req_bytes).hexdigest()[:16]


def compute_stamp(gpu_vendor: str) -> str:
    """Computes a fingerprint of requirements.txt, Python version, and GPU vendor."""
    digest = compute_req_digest()
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}"
    return f"py={py_ver}|gpu={gpu_vendor}|req={digest}"


def core_imports_healthy() -> bool:
    """Fast metadata check (<2ms) that critical runtime packages are installed."""
    return all(importlib.util.find_spec(mod) is not None for mod in REQUIRED_IMPORT_SPECS)


def is_stamp_valid() -> bool:
    """Checks if the existing install stamp matches current Python version and requirements.txt."""
    if not STAMP_FILE.exists():
        return False
    try:
        stamp = STAMP_FILE.read_text(encoding="utf-8").strip()
        py_ver = f"py={sys.version_info.major}.{sys.version_info.minor}"
        req_part = f"req={compute_req_digest()}"
        return py_ver in stamp and req_part in stamp and core_imports_healthy()
    except Exception:
        return False


def install_dependencies(force: bool = False) -> None:
    """Installs hardware-matched PyTorch and requirements.txt when needed."""
    if not force and is_stamp_valid():
        print("[Setup] Dependencies verified and up to date.")
        return

    gpu_vendor = detect_gpu_vendor()
    expected_stamp = compute_stamp(gpu_vendor)
    if not force and core_imports_healthy():
        try:
            STAMP_FILE.write_text(expected_stamp, encoding="utf-8")
        except Exception:
            pass
        print("[Setup] Dependencies verified and up to date.")
        return

    print(f"[Setup] Configuring Python {sys.version_info.major}.{sys.version_info.minor} environment for GPU: {gpu_vendor.upper()}...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "--upgrade", "pip"])

    if gpu_vendor == "nvidia":
        print("[Setup] Installing CUDA-accelerated PyTorch for NVIDIA GPU...")
        try:
            subprocess.check_call([
                sys.executable, "-m", "pip", "install",
                "torch==2.4.1", "torchvision==0.19.1", "torchaudio==2.4.1",
                "--index-url", "https://download.pytorch.org/whl/cu124",
            ])
        except subprocess.CalledProcessError:
            print("[Setup] Note: cu124 wheel unavailable for this Python version; installing default PyTorch...")
            subprocess.check_call([sys.executable, "-m", "pip", "install", "torch", "torchvision", "torchaudio"])

        # Filter out torch-directml on NVIDIA systems so DirectML doesn't intercept CUDA
        req_lines = [
            line for line in REQUIREMENTS_FILE.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
            and not line.strip().startswith(("torch==", "torchvision==", "torchaudio==", "torch-directml"))
        ]
        subprocess.check_call([sys.executable, "-m", "pip", "install", *req_lines])
    elif os.name == "nt" and gpu_vendor in ("amd", "intel"):
        print(f"[Setup] Installing DirectML-accelerated PyTorch for Windows {gpu_vendor.upper()} GPU...")
        if sys.version_info[:2] <= (3, 12):
            subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", str(REQUIREMENTS_FILE)])
        else:
            print("[Setup] Note: torch-directml requires Python <= 3.12; installing standard PyTorch packages...")
            req_lines = [
                line for line in REQUIREMENTS_FILE.read_text(encoding="utf-8").splitlines()
                if line.strip() and not line.strip().startswith("#")
                and not line.strip().startswith(("torch==", "torchvision==", "torchaudio==", "torch-directml"))
            ]
            subprocess.check_call([sys.executable, "-m", "pip", "install", "torch", "torchvision", "torchaudio", *req_lines])
    else:
        req_lines = [
            line for line in REQUIREMENTS_FILE.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
            and not line.strip().startswith("torch-directml")
        ]
        subprocess.check_call([sys.executable, "-m", "pip", "install", *req_lines])

    try:
        STAMP_FILE.write_text(expected_stamp, encoding="utf-8")
    except Exception:
        pass
    print("[Setup] Python dependencies installed successfully.")


def ensure_ssl_certificates() -> None:
    """Generates self-signed SSL certificates in certs/ if USE_HTTPS=true and certs are missing."""
    cert_path = BASE_DIR / "certs" / "cert.pem"
    key_path = BASE_DIR / "certs" / "key.pem"
    if cert_path.exists() and key_path.exists():
        return

    try:
        import datetime
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID

        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, "LM-Sanctuary Local"),
        ])
        now = datetime.datetime.now(datetime.timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now)
            .not_valid_after(now + datetime.timedelta(days=3650))
            .sign(key, hashes.SHA256())
        )
        cert_path.parent.mkdir(parents=True, exist_ok=True)
        key_path.write_bytes(
            key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            )
        )
        cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        print("[Setup] Generated local self-signed HTTPS certificate in certs/cert.pem")
    except Exception as e:
        print(f"[Setup] Note: Could not pre-generate SSL cert ({e})")


def ensure_llama_server_binary() -> None:
    """Ensures the prebuilt llama-server binary matching the host GPU is downloaded and detects a GPU."""
    try:
        from runners import local_server
        gpu_type = local_server.detect_gpu_type()
        gpu_type_file = os.path.join(local_server.LLAMA_BIN_DIR, "installed_gpu_type.txt")
        installed_type = ""
        if os.path.exists(gpu_type_file):
            try:
                with open(gpu_type_file, "r", encoding="utf-8") as f:
                    installed_type = f.read().strip()
            except Exception:
                pass

        if (
            os.path.exists(local_server.SERVER_EXE)
            and installed_type == gpu_type
            and local_server.has_gpu_devices()
        ):
            return

        print(f"[Setup] Downloading prebuilt llama-server binary for your GPU ({gpu_type})...")
        local_server.stop_local_server()
        if local_server.download_llama_server():
            with open(gpu_type_file, "w", encoding="utf-8") as f:
                f.write(gpu_type)
    except Exception as e:
        print(f"[Setup] Note: llama-server will be downloaded on first model load ({e})")


def main() -> int:
    force = "--force" in sys.argv or "--update" in sys.argv
    ensure_directories_and_env()
    install_dependencies(force=force)
    ensure_ssl_certificates()
    ensure_llama_server_binary()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
