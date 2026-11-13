import os
import time
import zipfile
import subprocess
import requests
import threading

from utils import lifecycle
from adapters.vram_orchestrator import serialized_gpu_operation

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LLAMA_BIN_DIR = os.path.join(BASE_DIR, "utils", "llama-bin")
SERVER_EXE = os.path.join(LLAMA_BIN_DIR, "llama-server.exe") if os.name == 'nt' else os.path.join(LLAMA_BIN_DIR, "llama-server")
_proc = None
_starting = False
_start_lock = threading.Lock()
_on_status_change = None  # Callback set by app.py to broadcast SSE events
_cached_gpu_type = None
_http_session = None

def read_gguf_metadata(model_path: str) -> dict:
    """Reads architectural dimensions and sampling defaults directly from the GGUF binary header."""
    import struct
    sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
    fmts = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
    meta: dict = {}
    if not model_path or not os.path.exists(model_path):
        return meta
    try:
        with open(model_path, "rb") as f:
            def rd(fmt):
                return struct.unpack(fmt, f.read(struct.calcsize(fmt)))[0]

            def rd_str():
                return f.read(rd("<Q")).decode("utf-8", "replace")

            def rd_val(t):
                if t == 8:
                    return rd_str()
                if t == 9:
                    et, n = rd("<I"), rd("<Q")
                    return [rd_val(et) for _ in range(n)]
                return rd(fmts[t])

            def skip(t):
                if t == 8:
                    rd_str()
                elif t == 9:
                    et, n = rd("<I"), rd("<Q")
                    if et in sizes and n > 0:
                        f.seek(sizes[et] * n, 1)
                    else:
                        for _ in range(n):
                            skip(et)
                else:
                    f.seek(sizes[t], 1)

            if f.read(4) != b"GGUF":
                return meta
            rd("<I")
            rd("<Q")
            n_kv = rd("<Q")
            wanted_suffixes = (
                ".context_length",
                ".block_count",
                ".embedding_length",
                ".attention.head_count",
                ".attention.head_count_kv",
                ".attention.key_length",
                ".attention.value_length",
                ".attention.key_length_swa",
                ".attention.value_length_swa",
                ".attention.sliding_window",
                ".attention.sliding_window_pattern",
            )
            wanted_exact = {
                "general.architecture",
                "general.size_label",
                "general.sampling.temp",
                "general.sampling.top_p",
                "general.sampling.top_k",
            }
            for _ in range(n_kv):
                key, t = rd_str(), rd("<I")
                if key in wanted_exact or key.endswith(wanted_suffixes):
                    val = rd_val(t)
                    short_key = key.split(".", 1)[-1] if not key.startswith("general.") else key
                    meta[short_key] = val
                else:
                    skip(t)
    except Exception:
        pass
    swa_pattern = meta.get("attention.sliding_window_pattern")
    meta["has_swa"] = bool(
        meta.get("attention.sliding_window")
        and isinstance(swa_pattern, list)
        and any(swa_pattern)
    )
    return meta


def read_trained_context(model_path: str) -> int:
    """Reads '<arch>.context_length' from the GGUF header; returns 0 if unavailable."""
    return int(read_gguf_metadata(model_path).get("context_length") or 0)


def _kv_quant_bytes_per_elem(qtype: str) -> float:
    q = (qtype or "q8_0").strip().lower()
    if q in ("f32", "fp32"):
        return 4.0
    if q in ("f16", "bf16", "fp16"):
        return 2.0
    if q.startswith("q8"):
        return 1.0625
    if q.startswith("q5"):
        return 0.6875
    if q.startswith("q4") or q.startswith("iq4"):
        return 0.5625
    return 1.0625


def estimate_kv_cache_mib(meta: dict, ctx_tokens: int, ubatch_size: int = 512, ctk: str = "q8_0", ctv: str = "q8_0") -> float:
    """Computes physical KV cache footprint in MiB from GGUF layer/head dimensions (including hybrid SWA ring buffers)."""
    n_layer = int(meta.get("block_count") or 0)
    if n_layer <= 0 or ctx_tokens <= 0:
        return 0.0

    n_embd = int(meta.get("embedding_length") or 4096)
    n_head = int(meta.get("attention.head_count") or 32)
    default_head_dim = max(64, n_embd // max(1, n_head))
    d_k_full = int(meta.get("attention.key_length") or default_head_dim)
    d_v_full = int(meta.get("attention.value_length") or default_head_dim)
    d_k_swa = int(meta.get("attention.key_length_swa") or d_k_full)
    d_v_swa = int(meta.get("attention.value_length_swa") or d_v_full)

    raw_hkv = meta.get("attention.head_count_kv")
    if isinstance(raw_hkv, list) and len(raw_hkv) == n_layer:
        hkv_per_layer = [int(x) for x in raw_hkv]
    else:
        scalar_hkv = int(raw_hkv[0] if isinstance(raw_hkv, list) and raw_hkv else (raw_hkv or max(1, n_head // 4)))
        hkv_per_layer = [scalar_hkv] * n_layer

    swa_win = int(meta.get("attention.sliding_window") or 0)
    swa_pat = meta.get("attention.sliding_window_pattern")
    has_pat = isinstance(swa_pat, list) and len(swa_pat) == n_layer and swa_win > 0
    swa_tokens = min(ctx_tokens, swa_win + max(512, ubatch_size)) if swa_win > 0 else ctx_tokens

    bk = _kv_quant_bytes_per_elem(ctk)
    bv = _kv_quant_bytes_per_elem(ctv)

    total_bytes = 0.0
    for idx in range(n_layer):
        hkv = hkv_per_layer[idx]
        if has_pat and bool(swa_pat[idx]):
            layer_tokens = swa_tokens
            layer_bytes_per_tok = hkv * (d_k_swa * bk + d_v_swa * bv)
        else:
            layer_tokens = ctx_tokens
            layer_bytes_per_tok = hkv * (d_k_full * bk + d_v_full * bv)
        total_bytes += layer_tokens * layer_bytes_per_tok

    return total_bytes / (1024.0 * 1024.0)


def probe_fit_memory_mib(
    model_path: str,
    ctx_tokens: int,
    batch_size: int = 2048,
    ubatch_size: int = 512,
    ctk: str = "q8_0",
    ctv: str = "q8_0",
) -> tuple[int, int, int] | None:
    """Queries `llama-fit-params -fitp on` (~70ms) for exact (model_mib, context_mib, compute_mib) on the GPU."""
    exe = os.path.join(LLAMA_BIN_DIR, "llama-fit-params.exe" if os.name == "nt" else "llama-fit-params")
    if not os.path.exists(exe) or not os.path.exists(model_path):
        return None
    try:
        res = subprocess.run(
            [
                exe, "-m", model_path,
                "-c", str(ctx_tokens),
                "-b", str(batch_size),
                "-ub", str(ubatch_size),
                "-fa", "on",
                "-ctk", ctk,
                "-ctv", ctv,
                "-fitp", "on",
            ],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        for line in (res.stdout or "").splitlines():
            parts = line.strip().split()
            if len(parts) >= 4 and parts[0].lower() != "host" and all(p.isdigit() for p in parts[1:4]):
                return int(parts[1]), int(parts[2]), int(parts[3])
    except Exception:
        pass
    return None


def get_device_vram() -> tuple[int, int]:
    """Returns (total_vram_mib, free_vram_mib) from the active hardware GPU device, or (0, 0) if none."""
    if not os.path.exists(SERVER_EXE):
        return 0, 0
    try:
        flags = subprocess.CREATE_NO_WINDOW if (os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW")) else 0
        out = subprocess.check_output(
            [SERVER_EXE, "--list-devices"],
            text=True,
            stderr=subprocess.STDOUT,
            timeout=5.0,
            creationflags=flags,
        )
        if "(none)" in out.lower() or ":" not in out:
            return 0, 0
        import re
        m = re.search(r"\((\d+)\s*MiB(?:,\s*(\d+)\s*MiB free)?\)", out)
        if m:
            total_mib = int(m.group(1))
            free_mib = int(m.group(2)) if m.group(2) else max(0, total_mib - 2048)
            return total_mib, free_mib
    except Exception as e:
        print(f"[llama-runner] Could not query device VRAM: {e}", flush=True)
    return 0, 0


def resolve_runtime_profile(model_path: str) -> dict:
    """Programmatically derives context size, KV cache quantization, batch/ubatch sizes, GPU layer offload,
    and the conversational prompt crossover budget from GGUF metadata and physical GPU VRAM."""
    meta = read_gguf_metadata(model_path)
    trained = int(meta.get("context_length") or 0)
    n_layers = int(meta.get("block_count") or 0)
    model_size_bytes = os.path.getsize(model_path) if (model_path and os.path.exists(model_path)) else 0
    model_size_mib = int(model_size_bytes / (1024 * 1024))

    total_vram, _ = get_device_vram()
    user_margin = os.getenv("LOCAL_VRAM_MARGIN_MB", "").strip()
    if user_margin.isdigit():
        margin_mib = int(user_margin)
    elif total_vram > 0:
        # Scale OS/display reserve margin proportionally (11% of total VRAM, clamped between 1536 and 2816 MiB)
        margin_mib = max(1536, min(2816, int(total_vram * 0.11)))
    else:
        margin_mib = 2048

    usable_vram = max(0, total_vram - margin_mib) if total_vram > 0 else 0
    vram_headroom = usable_vram - model_size_mib if total_vram > 0 else 4096

    # 1. KV Cache Quantization (ctk / ctv)
    raw_ctk = (os.getenv("LOCAL_CACHE_TYPE_K") or "auto").strip().lower()
    raw_ctv = (os.getenv("LOCAL_CACHE_TYPE_V") or "auto").strip().lower()
    auto_quant = "q4_0" if (total_vram > 0 and vram_headroom < 2200) else "q8_0"
    ctk = auto_quant if raw_ctk in ("", "auto") else raw_ctk
    ctv = auto_quant if raw_ctv in ("", "auto") else raw_ctv

    # 2. Batch & Micro-Batch Sizes (-b / -ub)
    # Compute buffer scales nearly linearly with -ub (572 MiB @ ub=512, 1397 MiB @ ub=1024, 2797 MiB @ ub=2048 on 31B).
    raw_b = (os.getenv("LOCAL_BATCH_SIZE") or "auto").strip().lower()
    raw_ub = (os.getenv("LOCAL_UBATCH_SIZE") or "auto").strip().lower()
    if raw_ub.isdigit():
        ubatch_size = int(raw_ub)
    elif total_vram == 0 or vram_headroom < 3200:
        ubatch_size = 512
    elif vram_headroom < 7500:
        ubatch_size = 1024
    else:
        ubatch_size = 2048

    if raw_b.isdigit():
        batch_size = max(ubatch_size, int(raw_b))
    else:
        batch_size = max(ubatch_size, 1024 if vram_headroom < 2000 else 2048)

    # 3. GPU Layer Offload (-ngl)
    raw_ngl = (os.getenv("LOCAL_GPU_LAYERS") or "auto").strip().lower()
    if raw_ngl.isdigit() and raw_ngl != "99":
        gpu_layers = raw_ngl
    elif total_vram > 0 and model_size_mib > 0 and usable_vram < model_size_mib + 1024 and n_layers > 0:
        # Partial offload when model + minimal KV cache exceeds usable VRAM
        avail_for_weights = max(0, usable_vram - 1280)
        fitted_layers = max(0, min(n_layers, int((avail_for_weights / max(1, model_size_mib)) * n_layers)))
        gpu_layers = str(fitted_layers)
    else:
        gpu_layers = "99"

    # 4. Context Size (-c)
    is_large_model = model_size_mib > 14000
    is_medium_model = 7000 < model_size_mib <= 14000
    default_ceiling = 16384 if is_large_model else (24576 if is_medium_model else 32768)

    lo = int(os.getenv("LOCAL_CONTEXT_MIN", "8192"))
    max_env = (os.getenv("LOCAL_CONTEXT_MAX") or "").strip()
    hi = int(max_env) if max_env.isdigit() else default_ceiling
    if trained > 0:
        hi = min(hi, trained)
    lo = min(lo, hi)

    ctx_setting = (os.getenv("LOCAL_CONTEXT") or "auto").strip().lower()
    if ctx_setting.isdigit():
        ctx_size = int(ctx_setting)
    else:
        # Probe exact memory curve from llama-fit-params (-fitp on) at lo and hi, or fall back to GGUF header formula
        probe_lo = probe_fit_memory_mib(model_path, lo, batch_size, ubatch_size, ctk, ctv)
        if probe_lo is not None and total_vram > 0:
            model_mib, kv_lo_mib, comp_lo_mib = probe_lo
            probe_hi = probe_fit_memory_mib(model_path, hi, batch_size, ubatch_size, ctk, ctv) if hi > lo else probe_lo
            if probe_hi is not None and hi > lo:
                _, kv_hi_mib, comp_hi_mib = probe_hi
                marginal_mib_per_tok = max(0.005, ((kv_hi_mib + comp_hi_mib) - (kv_lo_mib + comp_lo_mib)) / float(hi - lo))
            else:
                marginal_mib_per_tok = max(0.01, kv_lo_mib / float(max(1, lo)))
            base_used = model_mib + kv_lo_mib + comp_lo_mib
            extra_mib = max(0, usable_vram - base_used)
            vram_limit_tokens = lo + int(extra_mib / marginal_mib_per_tok)
            safe_fit = max(lo, min(hi, (vram_limit_tokens // 1024) * 1024))
        elif total_vram > 0 and model_size_mib > 0:
            est_lo = estimate_kv_cache_mib(meta, lo, ubatch_size, ctk, ctv)
            est_hi = estimate_kv_cache_mib(meta, hi, ubatch_size, ctk, ctv)
            comp_est = 560 if ubatch_size <= 512 else (1400 if ubatch_size <= 1024 else 2750)
            if est_lo > 0 and hi > lo:
                marginal = max(0.005, (est_hi - est_lo) / float(hi - lo))
                extra_mib = max(0, usable_vram - model_size_mib - int(est_lo) - comp_est)
                vram_limit_tokens = lo + int(extra_mib / marginal)
                safe_fit = max(lo, min(hi, (vram_limit_tokens // 1024) * 1024))
            else:
                safe_fit = lo
        else:
            safe_fit = hi
        ctx_size = max(lo, (safe_fit // 1024) * 1024)

    # 5. Conversational Prompt Crossover Budget (LOCAL_CHAT_BUDGET)
    # Balances active dialogue window against quadratic attention prefill latency so memory + vectors
    # take over before prefill slows down interactive turns.
    raw_chat_budget = (os.getenv("LOCAL_CHAT_BUDGET_OVERRIDE") or "").strip()
    if raw_chat_budget.isdigit():
        chat_budget = max(2048, int(raw_chat_budget))
    elif is_large_model:
        chat_budget = min(4096, max(2560, int(ctx_size * 0.34)))
    elif is_medium_model:
        chat_budget = min(6144, max(3072, int(ctx_size * 0.40)))
    else:
        chat_budget = min(8192, max(4096, int(ctx_size * 0.50)))
    chat_budget = (chat_budget // 256) * 256

    print(
        f"[llama-runner] Hardware profile: model={model_size_mib}MB, vram={total_vram}MB (margin={margin_mib}MB), "
        f"ctx={ctx_size}, chat_budget={chat_budget}, b={batch_size}, ub={ubatch_size}, kv={ctk}/{ctv}, ngl={gpu_layers}, swa={meta.get('has_swa', False)}",
        flush=True,
    )
    return {
        "context_size": str(ctx_size),
        "chat_budget": str(chat_budget),
        "batch_size": str(batch_size),
        "ubatch_size": str(ubatch_size),
        "ctk": ctk,
        "ctv": ctv,
        "gpu_layers": gpu_layers,
        "has_swa": bool(meta.get("has_swa")),
        "meta": meta,
    }


def resolve_context_size(model_path: str, gpu_layers: str = "auto", ctk: str = "auto", ctv: str = "auto") -> str:
    """Returns the resolved context size string for `model_path`."""
    return resolve_runtime_profile(model_path)["context_size"]


def _get_http_session() -> requests.Session:
    global _http_session
    if _http_session is None:
        _http_session = requests.Session()
    return _http_session

def _has_windows_rocm_sdk() -> bool:
    """Checks whether an external system-wide AMD HIP SDK (hipblas.dll + rocblas.dll) is on disk for llama-server.exe.
    Note: Do NOT use ctypes.WinDLL('hipblas.dll') here, because PyTorch's in-process _rocm_sdk_core wheel preloads
    hipblas.dll into Python's own address space even when standalone llama-server.exe has no system HIP SDK on PATH.
    """
    if os.name != "nt":
        return False
    import sys
    venv_prefix = os.path.normcase(os.path.abspath(sys.prefix))
    candidate_dirs = []
    hip_path = os.environ.get("HIP_PATH", "").strip()
    if hip_path:
        candidate_dirs.append(os.path.join(hip_path, "bin"))
    for p in os.environ.get("PATH", "").split(os.pathsep):
        p = p.strip().strip('"')
        if p:
            candidate_dirs.append(p)
    found_hipblas = False
    found_rocblas = False
    for d in candidate_dirs:
        norm_d = os.path.normcase(os.path.abspath(d))
        if norm_d.startswith(venv_prefix) or "site-packages" in norm_d:
            continue
        if os.path.isfile(os.path.join(d, "hipblas.dll")):
            found_hipblas = True
        if os.path.isfile(os.path.join(d, "rocblas.dll")):
            found_rocblas = True
        if found_hipblas and found_rocblas:
            return True
    return False


def has_gpu_devices() -> bool:
    """Verifies that the installed llama-server binary enumerates at least one hardware GPU device."""
    total, _ = get_device_vram()
    return total > 0


def detect_gpu_type() -> str:
    """Detects the optimal GPU backend ('amd', 'nvidia', 'vulkan', or 'metal') for llama-server."""
    global _cached_gpu_type
    forced_gpu = (os.getenv("LOCAL_GPU_TYPE") or "").strip().lower()
    if forced_gpu in ("amd", "nvidia", "vulkan", "metal"):
        if os.name == "nt" and forced_gpu == "amd" and not _has_windows_rocm_sdk():
            print("[llama-runner] AMD ROCm BLAS runtime (hipblas.dll) not found; using Vulkan backend for AMD GPU acceleration.", flush=True)
            return "vulkan"
        return forced_gpu

    if _cached_gpu_type:
        return _cached_gpu_type

    import sys
    if sys.platform == "darwin":
        _cached_gpu_type = "metal"
        return _cached_gpu_type

    if os.name != "nt":
        try:
            subprocess.check_output(["nvidia-smi"], stderr=subprocess.DEVNULL)
            _cached_gpu_type = "nvidia"
            return _cached_gpu_type
        except Exception:
            _cached_gpu_type = "vulkan"
            return _cached_gpu_type

    try:
        output = subprocess.check_output(
            'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
            shell=True,
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=5.0,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        output_lower = output.lower()
        if "nvidia" in output_lower:
            _cached_gpu_type = "nvidia"
        elif "amd" in output_lower or "radeon" in output_lower:
            if _has_windows_rocm_sdk():
                _cached_gpu_type = "amd"
            else:
                _cached_gpu_type = "vulkan"
        else:
            _cached_gpu_type = "vulkan"
        return _cached_gpu_type
    except Exception:
        pass

    _cached_gpu_type = "vulkan"
    return _cached_gpu_type


def _download_and_extract_archive(asset: dict) -> None:
    import tarfile
    temp_archive = os.path.join(LLAMA_BIN_DIR, asset["name"])
    with requests.get(asset["browser_download_url"], stream=True, timeout=60.0) as r:
        r.raise_for_status()
        with open(temp_archive, "wb") as f:
            for chunk in r.iter_content(65536):
                if chunk:
                    f.write(chunk)
    if temp_archive.endswith(".zip"):
        with zipfile.ZipFile(temp_archive, "r") as zip_ref:
            zip_ref.extractall(LLAMA_BIN_DIR)
    elif temp_archive.endswith(".tar.gz"):
        with tarfile.open(temp_archive, "r:gz") as tar_ref:
            tar_ref.extractall(LLAMA_BIN_DIR)
    os.remove(temp_archive)


def download_llama_server(override_gpu_type: str | None = None):
    import sys
    import platform
    os.makedirs(LLAMA_BIN_DIR, exist_ok=True)
    api_url = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
    try:
        resp = requests.get(api_url, headers={"User-Agent": "LM-Sanctuary-Client/1.0"}, timeout=10.0).json()
        release = next(r for r in resp if len(r.get("assets", [])) > 5)
        assets = release.get("assets", [])

        gpu_type = override_gpu_type or detect_gpu_type()
        print(f"[llama-runner] Detected GPU type: {gpu_type}", flush=True)

        if os.name == "nt":
            if gpu_type == "amd":
                target_keywords = ["win-rocm", "win-hip", "win-vulkan-x64"]
            elif gpu_type == "nvidia":
                target_keywords = ["win-cuda-12.4-x64", "win-cuda", "win-vulkan-x64"]
            else:
                target_keywords = ["win-vulkan-x64"]
        elif sys.platform == "darwin":
            arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
            target_keywords = [f"macos-{arch}"]
        else:
            target_keywords = ["ubuntu-vulkan-x64", "ubuntu-x64"]

        asset = None
        matched_kw = None
        for kw in target_keywords:
            for a in assets:
                name = a.get("name", "").lower()
                if name.startswith("llama-") and kw in name and (name.endswith(".zip") or name.endswith(".tar.gz")):
                    asset = a
                    matched_kw = kw
                    break
            if asset:
                break

        if not asset and os.name == "nt":
            print("[llama-runner] Target asset not found, using Vulkan build", flush=True)
            asset = next(
                (a for a in assets if a.get("name", "").lower().startswith("llama-") and "win-vulkan-x64" in a.get("name", "").lower() and a.get("name", "").endswith(".zip")),
                None,
            )

        if not asset:
            raise RuntimeError(f"No compatible llama-server release binary found for platform {sys.platform} ({gpu_type})")

        # Clean existing bin directory before extracting to prevent DLL conflicts
        for f_name in os.listdir(LLAMA_BIN_DIR):
            f_path = os.path.join(LLAMA_BIN_DIR, f_name)
            if os.path.isfile(f_path):
                try:
                    os.remove(f_path)
                except Exception:
                    pass

        print(f"[llama-runner] Downloading {asset['name']}...", flush=True)
        _download_and_extract_archive(asset)

        # On Windows NVIDIA CUDA builds, also extract the companion cudart archive so cublas/cudart DLLs are present
        if os.name == "nt" and gpu_type == "nvidia" and matched_kw and "win-cuda" in matched_kw:
            cudart_asset = next(
                (a for a in assets if a.get("name", "").lower().startswith("cudart-") and matched_kw in a.get("name", "").lower() and a.get("name", "").endswith(".zip")),
                None,
            )
            if cudart_asset:
                print(f"[llama-runner] Downloading CUDA runtime companion {cudart_asset['name']}...", flush=True)
                _download_and_extract_archive(cudart_asset)

        # If archive extracted into a nested subfolder (e.g. build/bin/llama-server), hoist binaries to LLAMA_BIN_DIR
        if not os.path.exists(SERVER_EXE):
            target_name = os.path.basename(SERVER_EXE)
            for root, _, files in os.walk(LLAMA_BIN_DIR):
                if target_name in files and os.path.abspath(root) != os.path.abspath(LLAMA_BIN_DIR):
                    import shutil
                    for item in os.listdir(root):
                        src = os.path.join(root, item)
                        dst = os.path.join(LLAMA_BIN_DIR, item)
                        if os.path.isfile(src):
                            shutil.move(src, dst)
                    break

        if os.name != "nt" and os.path.exists(SERVER_EXE):
            try:
                os.chmod(SERVER_EXE, 0o755)
            except Exception:
                pass

        print(f"[llama-runner] Successfully installed llama-server ({asset['name']})", flush=True)
        return True
    except Exception as e:
        print(f"[llama-runner] Error installing: {e}", flush=True)
        return False

_local_models_list_cached = None
_local_models_list_cache_time = 0.0


def _persist_model_to_env(model_name: str) -> None:
    try:
        env_path = os.path.join(BASE_DIR, ".env")
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
            updated = False
            for i, line in enumerate(lines):
                if line.strip().startswith("LOCAL_MODEL_NAME="):
                    lines[i] = f"LOCAL_MODEL_NAME={model_name}\n"
                    updated = True
                    break
            if not updated:
                lines.append(f"\nLOCAL_MODEL_NAME={model_name}\n")
            with open(env_path, "w", encoding="utf-8") as f:
                f.writelines(lines)
        os.environ["LOCAL_MODEL_NAME"] = model_name
    except Exception:
        pass


def scan_gguf_files(base_dir):
    models = []
    try:
        for root, _, files in os.walk(base_dir):
            for file in files:
                if file.lower().endswith(".gguf"):
                    rel_path = os.path.relpath(os.path.join(root, file), base_dir)
                    models.append(rel_path.replace("\\", "/"))
    except Exception:
        pass
    return models


def list_local_models(force_refresh=False):
    global _local_models_list_cached, _local_models_list_cache_time
    now = time.time()
    if not force_refresh and _local_models_list_cached is not None and (now - _local_models_list_cache_time < 5.0):
        return _local_models_list_cached

    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    base_models_dir = os.path.join(BASE_DIR, "models")
    lm_studio_models_dir = os.path.join(user_profile, ".lmstudio", "models")

    models = []
    if os.path.exists(base_models_dir):
        models.extend(scan_gguf_files(base_models_dir))
    if os.path.exists(lm_studio_models_dir):
        models.extend(scan_gguf_files(lm_studio_models_dir))

    _local_models_list_cached = sorted(list(set(models)))
    _local_models_list_cache_time = now
    return _local_models_list_cached


def list_gguf_models():
    """Lists all discovered GGUF models in models/ and ~/.lmstudio/models/ with metadata."""
    from variables.settings import LLM_MODELS_DIR, MODELS_DIR
    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    lm_studio_models_dir = os.path.join(user_profile, ".lmstudio", "models")
    models = []
    seen = set()

    for search_dir in (LLM_MODELS_DIR, MODELS_DIR, lm_studio_models_dir):
        if not os.path.exists(search_dir):
            continue
        try:
            for root, _, files in os.walk(search_dir):
                for f in files:
                    if f.lower().endswith(".gguf") and f not in seen:
                        seen.add(f)
                        full_path = os.path.join(root, f)
                        size_gb = round(os.path.getsize(full_path) / (1024 ** 3), 2)
                        models.append({
                            "name": f,
                            "filename": f,
                            "path": full_path,
                            "size_gb": size_gb,
                            "folder": os.path.relpath(root, MODELS_DIR) if full_path.startswith(MODELS_DIR) else "lmstudio"
                        })
        except Exception as e:
            print(f"[llama-runner] Error scanning directory {search_dir}: {e}")

    return sorted(models, key=lambda x: x["name"])


def get_loaded_model_name():
    """Returns the filename of the active or configured GGUF model."""
    target = _current_model or os.getenv("LOCAL_MODEL_NAME", "")
    if target:
        resolved = resolve_model_path(target)
        return os.path.basename(resolved or target)
    downloaded = list_local_models()
    if downloaded:
        return os.path.basename(downloaded[0])
    return None


def resolve_model_path(model_key):
    if not model_key or not model_key.strip(): return None
    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    paths = [
        os.path.join(BASE_DIR, "models", model_key),
        os.path.join(user_profile, ".lmstudio", "models", model_key),
        model_key
    ]
    resolved = next((os.path.normpath(p) for p in paths if os.path.isfile(p)), None)
    if resolved:
        return resolved

    clean_key = os.path.basename(model_key).lower()
    downloaded = list_local_models()
    for d in downloaded:
        if os.path.basename(d).lower() == clean_key or clean_key in d.lower():
            for p in [os.path.join(BASE_DIR, "models", d), os.path.join(user_profile, ".lmstudio", "models", d), d]:
                if os.path.isfile(p):
                    return os.path.normpath(p)
    return None

_current_model = None

@serialized_gpu_operation
def start_local_server(model_key=None):
    global _proc, _current_model, _starting
    
    explicit_selection = bool(model_key and model_key != "local-llm")
    if not model_key or model_key == "local-llm":
        model_key = os.getenv("LOCAL_MODEL_NAME", "")

    with _start_lock:
        if _starting:
            return True, "Already starting"
            
    is_online = check_local_server_status()
    model_path = resolve_model_path(model_key)
    if not model_path:
        downloaded = list_local_models()
        if downloaded:
            model_key = downloaded[0]
            model_path = resolve_model_path(model_key)
            _persist_model_to_env(model_key)
        if not model_path:
            return False, f"Model not found: {model_key}"
    elif explicit_selection:
        _persist_model_to_env(model_key)
        
    gpu_type = detect_gpu_type()
    gpu_type_file = os.path.join(LLAMA_BIN_DIR, "installed_gpu_type.txt")
    installed_type = "unknown"
    if os.path.exists(gpu_type_file):
        try:
            with open(gpu_type_file, "r") as f:
                installed_type = f.read().strip()
        except Exception:
            pass

    # Check if server is running with the expected GPU backend and has this model loaded
    if is_online is True and installed_type == gpu_type:
        from models.models import fetch_local_models
        loaded = fetch_local_models()
        if loaded:
            target_base = os.path.basename(model_path).lower()
            for m in loaded:
                val = m.get("value", "")
                if val:
                    val_base = os.path.basename(val).lower()
                    if val_base == target_base or val.lower() == model_key.lower():
                        _current_model = model_key
                        if not os.getenv("LOCAL_CHAT_BUDGET") or os.getenv("LOCAL_CONTEXT", "auto") == "auto":
                            prof = resolve_runtime_profile(model_path)
                            os.environ["LOCAL_CONTEXT"] = prof["context_size"]
                            os.environ["LOCAL_CHAT_BUDGET"] = prof["chat_budget"]
                        return True, "Online (already running)"
                        
    # If online with another model, mismatched GPU backend, or booting up, stop first to be clean
    if is_online:
        stopped, message = stop_local_server()
        if not stopped:
            return False, message
        
    if not os.getenv("LOCAL_MODEL_NAME") and model_key:
        os.environ["LOCAL_MODEL_NAME"] = model_key
        
    reinstall = False
    if not os.path.exists(SERVER_EXE):
        reinstall = True
    elif installed_type != gpu_type:
        print(f"[llama-runner] Reinstalling llama-server: installed type '{installed_type}' differs from detected GPU type '{gpu_type}'", flush=True)
        reinstall = True
        stopped, message = stop_local_server()
        if not stopped:
            return False, message
    elif not has_gpu_devices():
        if os.name == "nt" and gpu_type != "vulkan":
            print(f"[llama-runner] Installed llama-server ({installed_type}) detected 0 GPU devices; switching to Vulkan backend...", flush=True)
            gpu_type = "vulkan"
            global _cached_gpu_type
            _cached_gpu_type = "vulkan"
        else:
            print(f"[llama-runner] Installed llama-server ({installed_type}) detected 0 GPU devices; reinstalling...", flush=True)
        reinstall = True
        stopped, message = stop_local_server()
        if not stopped:
            return False, message
            
    if reinstall:
        if not download_llama_server(override_gpu_type=gpu_type):
            return False, "Failed download"
        if os.name == "nt" and gpu_type != "vulkan" and not has_gpu_devices():
            print(f"[llama-runner] Downloaded '{gpu_type}' build detected 0 GPU devices; switching to Vulkan backend...", flush=True)
            gpu_type = "vulkan"
            _cached_gpu_type = "vulkan"
            if not download_llama_server(override_gpu_type="vulkan"):
                return False, "Failed Vulkan download"
        try:
            with open(gpu_type_file, "w") as f:
                f.write(gpu_type)
        except Exception:
            pass

    profile = resolve_runtime_profile(model_path)
    gpu_layers = profile["gpu_layers"]
    batch_size = profile["batch_size"]
    ubatch_size = profile["ubatch_size"]
    ctk = profile["ctk"]
    ctv = profile["ctv"]
    context_size = profile["context_size"]
    os.environ["LOCAL_CONTEXT"] = context_size
    os.environ["LOCAL_CHAT_BUDGET"] = profile["chat_budget"]

    flash_attn = os.getenv("LOCAL_FLASH_ATTN", "true").lower() == "true"
    no_mmap = os.getenv("LOCAL_NO_MMAP", "false").lower() == "true"

    cmd = [
        SERVER_EXE,
        "-m", model_path,
        "-c", context_size,
        "-b", batch_size,
        "-ub", ubatch_size,
        "--port", "1234",
        "--host", "127.0.0.1",
        "-ngl", gpu_layers,
        "-np", "1",
        "-fa", "on" if flash_attn else "off",
        "-ctk", ctk,
        "-ctv", ctv,
        "--no-warmup",
    ]
    if not profile.get("has_swa"):
        cmd.extend(["--cache-reuse", "64"])

    if no_mmap:
        cmd.append("--no-mmap")

    from variables.settings import is_thinking_enabled
    if not is_thinking_enabled():
        cmd.extend(["--reasoning", "off", "--reasoning-budget", "0"])
    # --- AUTOMATIC LOGIT BIAS INJECTION ---
    try:
        from core.banned_words import generate_llama_cli_args
        # Generates token-level bias flags dynamically from the active model's GGUF file
        bias_args = generate_llama_cli_args(model_path)
        if bias_args:
            cmd.extend(bias_args)
            print("[llama-runner] Applied logit bias suppression rules from banned_words.json", flush=True)
    except Exception as e:
        print(f"[llama-runner] Warning: Could not apply logit bias: {e}", flush=True)
    # --------------------------------------

    try:
        from variables.settings import LOGS_DIR
        log_file = os.path.join(LOGS_DIR, "llama_server.log")
        with open(log_file, "a", encoding="utf-8") as log_fd:
            log_fd.write(f"\n--- START {time.asctime()} ---\n")
            if os.name == 'nt':
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 0
                flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0x08000000
                _proc = lifecycle.track(subprocess.Popen(cmd, stdout=log_fd, stderr=log_fd, startupinfo=si, creationflags=flags, shell=False))
            else:
                _proc = lifecycle.track(subprocess.Popen(cmd, stdout=log_fd, stderr=log_fd, shell=False))
                
        with _start_lock:
            _starting = True
            
        if _on_status_change:
            _on_status_change()
            
        def _wait_for_server():
            global _current_model, _starting
            try:
                for _ in range(300):
                    time.sleep(1.0)
                    if _proc and _proc.poll() is not None:
                        break
                    status = check_local_server_status()
                    if status is True:
                        _current_model = model_key
                        break
            finally:
                with _start_lock:
                    _starting = False
                if _on_status_change:
                    _on_status_change()
                    
        threading.Thread(target=_wait_for_server, daemon=True).start()
        return True, "Starting"
    except Exception as e:
        with _start_lock:
            _starting = False
        return False, str(e)

@serialized_gpu_operation
def stop_local_server():
    global _proc, _current_model, _starting, _http_session
    _current_model = None
    
    with _start_lock:
        _starting = False
        
    if _http_session:
        try:
            _http_session.close()
        except Exception:
            pass
        _http_session = None

    if _proc and _proc.poll() is None:
        try:
            _proc.terminate()
            _proc.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            try:
                _proc.kill()
                _proc.wait(timeout=2.0)
            except (OSError, subprocess.TimeoutExpired) as e:
                return False, f"Could not stop the managed llama-server process: {e}"
        except OSError as e:
            return False, f"Could not stop the managed llama-server process: {e}"
    _proc = None

    if check_local_server_status():
        return False, "A local server is still listening on port 1234; stop it before switching to image mode."
    return True, "Stopped"

def check_local_server_status():
    try:
        session = _get_http_session()
        resp = session.get("http://127.0.0.1:1234/health", timeout=1.0)
        if resp.status_code == 200:
            return True
        if resp.status_code == 503:
            return "starting"
    except Exception:
        pass
        
    global _starting
    if _starting:
        return "starting"
        
    return False

def is_model_loaded(model_key=None) -> bool:
    """Checks if the local server is running AND serving the requested model."""
    status = check_local_server_status()
    if status is not True:
        return False
    if not model_key or model_key == "local-llm":
        model_key = os.getenv("LOCAL_MODEL_NAME", "")

    target_path = resolve_model_path(model_key) if model_key else None
    if not target_path:
        downloaded = list_local_models()
        if downloaded:
            target_path = resolve_model_path(downloaded[0])

    if not target_path:
        return True

    target_base = os.path.basename(target_path).lower()

    global _current_model
    if _current_model:
        curr_path = resolve_model_path(_current_model)
        curr_base = os.path.basename(curr_path or _current_model).lower()
        if curr_base == target_base:
            return True

    from models.models import fetch_local_models
    loaded = fetch_local_models(force_refresh=True)
    if loaded:
        for m in loaded:
            val = m.get("value", "")
            if val:
                val_path = resolve_model_path(val)
                val_base = os.path.basename(val_path or val).lower()
                if val_base == target_base or (target_path and val_path and os.path.samefile(val_path, target_path)):
                    _current_model = val
                    return True
        return False
    return False

def ensure_server_online(model_key=None, timeout=120.0) -> bool:
    """Ensures local LLM server is up, responsive, and serving the requested model."""
    if not model_key or model_key == "local-llm":
        model_key = os.getenv("LOCAL_MODEL_NAME", "")

    if is_model_loaded(model_key):
        return True

    print(f"[Local LLM] Server offline or switching model. Starting server (model: {model_key or 'default'})...", flush=True)
    success, msg = start_local_server(model_key)
    if not success:
        print(f"[Local LLM] Failed to start local server: {msg}", flush=True)
        return False

    start_wait = time.time()
    poll_interval = 0.25
    while time.time() - start_wait < timeout:
        time.sleep(poll_interval)
        poll_interval = min(poll_interval * 2, 1.0)
        status = check_local_server_status()
        if status is True:
            # Server healthy — verify correct model is loaded
            if is_model_loaded(model_key):
                return True
        elif status is False and _proc and _proc.poll() is not None:
            print(f"[Local LLM] Server process exited during startup with code {_proc.poll()}.", flush=True)
            return False

    print(f"[Local LLM] Server startup timed out after {timeout}s.", flush=True)
    return False
