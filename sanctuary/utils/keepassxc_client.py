# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
"""In-app KDBX 4.0 encrypted credential vault and KeePassXC-protocol service."""

from __future__ import annotations

import base64
import gzip
import hashlib
import hmac
import os
import struct
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import padding as sym_padding
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.argon2 import Argon2d, Argon2i, Argon2id
from cryptography.hazmat.primitives.poly1305 import Poly1305
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from lxml import etree

_SIGMA = b"expand 32-byte k"
_KDBX_SIG1 = 0x9AA2D903
_KDBX_SIG2 = 0xB54BFB67
_KDBX_VER_3 = 0x00030000
_KDBX_VER_4 = 0x00040000

_CIPHER_AES256_CBC = bytes.fromhex("31c1f2e6bf714350be5805216afc5aff")
_CIPHER_CHACHA20 = bytes.fromhex("d6038a2b8b6f4cb5a524339a31dbb59a")

_KDF_AES = bytes.fromhex("c9d9f39a628a4460bf740d08c18a4fea")
_KDF_ARGON2D = bytes.fromhex("ef636ddf8c29444b91f7a9a403e30a0c")
_KDF_ARGON2I = bytes.fromhex("9ecc90c9277c491fa3bcb811a2c38f8b")
_KDF_ARGON2ID = bytes.fromhex("9e298b1956db4773b23dfc3ec6f0a1e6")

_SALSA20_IV = bytes.fromhex("e830094b97205d2a")
_HMAC_BLOCK_SIZE = 1024 * 1024
_XML_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, remove_blank_text=False)

VAULT_MASTER_KEY_URL = "https://lm-sanctuary.local/vault-master-key"
VAULT_MASTER_KEY_LOGIN = "lm-sanctuary-vault"


class KeePassXCUnavailableError(RuntimeError):
    """Raised when the vault backend is unavailable."""


class KeePassXCLockedError(RuntimeError):
    """Raised when the KDBX database is locked."""


class KeePassXCAssociationError(RuntimeError):
    """Raised when the KDBX vault has not been initialized yet."""


class KeePassXCAuthError(RuntimeError):
    """Raised when an incorrect master password is supplied."""


class KeePassXCMigrationPasswordError(RuntimeError):
    """Raised when a previous Sanctuary .kdbx uses a different password and is needed to migrate the master key."""


def _rotl32(x: int, c: int) -> int:
    return ((x << c) | (x >> (32 - c))) & 0xFFFFFFFF


def _qr(y: list[int], a: int, b: int, c: int, d: int) -> None:
    y[b] ^= _rotl32((y[a] + y[d]) & 0xFFFFFFFF, 7)
    y[c] ^= _rotl32((y[b] + y[a]) & 0xFFFFFFFF, 9)
    y[d] ^= _rotl32((y[c] + y[b]) & 0xFFFFFFFF, 13)
    y[a] ^= _rotl32((y[d] + y[c]) & 0xFFFFFFFF, 18)


def _salsa20_rounds(state: list[int]) -> list[int]:
    y = list(state)
    for _ in range(10):
        _qr(y, 0, 4, 8, 12)
        _qr(y, 5, 9, 13, 1)
        _qr(y, 10, 14, 2, 6)
        _qr(y, 15, 3, 7, 11)
        _qr(y, 0, 1, 2, 3)
        _qr(y, 5, 6, 7, 4)
        _qr(y, 10, 11, 8, 9)
        _qr(y, 15, 12, 13, 14)
    return y


def hsalsa20(key32: bytes, inp16: bytes) -> bytes:
    c = struct.unpack("<4I", _SIGMA)
    k = struct.unpack("<8I", key32)
    n = struct.unpack("<4I", inp16)
    st = [
        c[0], k[0], k[1], k[2],
        k[3], c[1], n[0], n[1],
        n[2], n[3], c[2], k[4],
        k[5], k[6], k[7], c[3],
    ]
    y = _salsa20_rounds(st)
    return struct.pack("<8I", y[0], y[5], y[10], y[15], y[6], y[7], y[8], y[9])


def salsa20_xor(key32: bytes, nonce8: bytes, data: bytes, initial_counter: int = 0) -> bytes:
    c = struct.unpack("<4I", _SIGMA)
    k = struct.unpack("<8I", key32)
    n = struct.unpack("<2I", nonce8)
    out = bytearray(len(data))
    blocks = (len(data) + 63) // 64
    for blk in range(blocks):
        cnt = initial_counter + blk
        cnt_lo = cnt & 0xFFFFFFFF
        cnt_hi = (cnt >> 32) & 0xFFFFFFFF
        st = [
            c[0], k[0], k[1], k[2],
            k[3], c[1], n[0], n[1],
            cnt_lo, cnt_hi, c[2], k[4],
            k[5], k[6], k[7], c[3],
        ]
        y = _salsa20_rounds(st)
        ks = struct.pack("<16I", *(((y[i] + st[i]) & 0xFFFFFFFF) for i in range(16)))
        off = blk * 64
        chunk = data[off : off + 64]
        for j, b in enumerate(chunk):
            out[off + j] = b ^ ks[j]
    return bytes(out)


def crypto_box_beforenm(peer_pk32: bytes, my_sk32: bytes) -> bytes:
    shared = X25519PrivateKey.from_private_bytes(my_sk32).exchange(
        X25519PublicKey.from_public_bytes(peer_pk32)
    )
    return hsalsa20(shared, b"\x00" * 16)


def crypto_box(msg: bytes, nonce24: bytes, peer_pk32: bytes, my_sk32: bytes) -> bytes:
    if len(nonce24) != 24:
        raise ValueError("NaCl box nonce must be 24 bytes")
    subkey = hsalsa20(crypto_box_beforenm(peer_pk32, my_sk32), nonce24[:16])
    stream0 = salsa20_xor(subkey, nonce24[16:24], b"\x00" * 64, 0)
    poly_key = stream0[:32]
    first32 = bytes(a ^ b for a, b in zip(msg[:32], stream0[32:64]))
    rest = salsa20_xor(subkey, nonce24[16:24], msg[32:], 1) if len(msg) > 32 else b""
    ct = first32 + rest
    tag = Poly1305.generate_tag(poly_key, ct)
    return tag + ct


def crypto_box_open(box: bytes, nonce24: bytes, peer_pk32: bytes, my_sk32: bytes) -> bytes:
    if len(nonce24) != 24:
        raise ValueError("NaCl box nonce must be 24 bytes")
    if len(box) < 16:
        raise ValueError("NaCl box ciphertext too short")
    tag, ct = box[:16], box[16:]
    subkey = hsalsa20(crypto_box_beforenm(peer_pk32, my_sk32), nonce24[:16])
    stream0 = salsa20_xor(subkey, nonce24[16:24], b"\x00" * 64, 0)
    try:
        Poly1305.verify_tag(stream0[:32], ct, tag)
    except InvalidSignature as exc:
        raise ValueError("NaCl box authentication failed") from exc
    first32 = bytes(a ^ b for a, b in zip(ct[:32], stream0[32:64]))
    rest = salsa20_xor(subkey, nonce24[16:24], ct[32:], 1) if len(ct) > 32 else b""
    return first32 + rest


def increment_nonce(nonce24: bytes) -> bytes:
    if len(nonce24) != 24:
        raise ValueError("Nonce must be 24 bytes")
    buf = bytearray(nonce24)
    carry = 1
    for i in range(24):
        carry += buf[i]
        buf[i] = carry & 0xFF
        carry >>= 8
    return bytes(buf)


def _raw_x25519_keypair() -> tuple[bytes, bytes]:
    sk = X25519PrivateKey.generate()
    pk = sk.public_key()
    return (
        pk.public_bytes(Encoding.Raw, PublicFormat.Raw),
        sk.private_bytes_raw(),
    )


def _b64e(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64d(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def _utc_now_b64() -> str:
    # KDBX 4 stores binary 8-byte timestamps as seconds since 0001-01-01T00:00:00Z, or ISO strings.
    epoch_0001 = 62135596800
    secs = int(datetime.now(timezone.utc).timestamp()) + epoch_0001
    return _b64e(struct.pack("<q", secs))


def _new_uuid_b64() -> str:
    return _b64e(uuid.uuid4().bytes)


def _uuid_b64_to_hex(b64_str: str) -> str:
    try:
        return _b64d(b64_str).hex()
    except Exception:
        return ""


def _parse_variant_dict(raw: bytes) -> dict[str, Any]:
    if len(raw) < 3:
        raise ValueError("VariantDictionary truncated")
    pos = 2  # skip uint16 version (0x0100)
    out: dict[str, Any] = {}
    while pos < len(raw):
        vtype = raw[pos]
        pos += 1
        if vtype == 0:
            break
        name_len = struct.unpack_from("<i", raw, pos)[0]
        pos += 4
        name = raw[pos : pos + name_len].decode("utf-8")
        pos += name_len
        val_len = struct.unpack_from("<i", raw, pos)[0]
        pos += 4
        val_bytes = raw[pos : pos + val_len]
        pos += val_len
        if vtype == 0x04:
            out[name] = struct.unpack("<I", val_bytes)[0]
        elif vtype == 0x05:
            out[name] = struct.unpack("<Q", val_bytes)[0]
        elif vtype == 0x08:
            out[name] = bool(val_bytes[0])
        elif vtype == 0x0C:
            out[name] = struct.unpack("<i", val_bytes)[0]
        elif vtype == 0x0D:
            out[name] = struct.unpack("<q", val_bytes)[0]
        elif vtype == 0x18:
            out[name] = val_bytes.decode("utf-8")
        elif vtype == 0x42:
            out[name] = val_bytes
        else:
            out[name] = val_bytes
    return out


def _serialize_variant_dict(items: list[tuple[int, str, Any]]) -> bytes:
    buf = bytearray(struct.pack("<H", 0x0100))
    for vtype, name, val in items:
        name_b = name.encode("utf-8")
        if vtype == 0x04:
            val_b = struct.pack("<I", int(val))
        elif vtype == 0x05:
            val_b = struct.pack("<Q", int(val))
        elif vtype == 0x08:
            val_b = struct.pack("<?", bool(val))
        elif vtype == 0x0C:
            val_b = struct.pack("<i", int(val))
        elif vtype == 0x0D:
            val_b = struct.pack("<q", int(val))
        elif vtype == 0x18:
            val_b = str(val).encode("utf-8")
        elif vtype == 0x42:
            val_b = bytes(val)
        else:
            raise ValueError(f"Unsupported VariantDictionary type: {vtype}")
        buf.append(vtype)
        buf.extend(struct.pack("<i", len(name_b)))
        buf.extend(name_b)
        buf.extend(struct.pack("<i", len(val_b)))
        buf.extend(val_b)
    buf.append(0)
    return bytes(buf)


def composite_key_from_password(password: str) -> bytes:
    if not isinstance(password, str) or not password:
        raise ValueError("Master password is required.")
    return hashlib.sha256(hashlib.sha256(password.encode("utf-8")).digest()).digest()


def _derive_kdf(composite_key: bytes, kdf_params: dict[str, Any]) -> bytes:
    kdf_uuid = kdf_params.get("$UUID")
    if kdf_uuid in (_KDF_ARGON2ID, _KDF_ARGON2D, _KDF_ARGON2I):
        salt = bytes(kdf_params["S"])
        lanes = int(kdf_params.get("P", 2))
        mem_bytes = int(kdf_params.get("M", 64 * 1024 * 1024))
        iterations = int(kdf_params.get("I", 3))
        memory_kib = max(8, mem_bytes // 1024)
        kdf_cls = (
            Argon2id if kdf_uuid == _KDF_ARGON2ID
            else (Argon2d if kdf_uuid == _KDF_ARGON2D else Argon2i)
        )
        return kdf_cls(
            salt=salt,
            length=32,
            iterations=iterations,
            lanes=lanes,
            memory_cost=memory_kib,
        ).derive(bytes(composite_key))
    if kdf_uuid == _KDF_AES:
        seed = bytes(kdf_params["S"])
        rounds = int(kdf_params.get("R", 60000))
        if rounds < 1 or rounds > 50_000_000:
            raise ValueError("Invalid AES-KDF round count")
        cipher = Cipher(algorithms.AES(seed), modes.ECB())
        enc = cipher.encryptor()
        key = bytes(composite_key)
        for _ in range(rounds):
            key = enc.update(key)
        enc.finalize()
        return hashlib.sha256(key).digest()
    raise ValueError("Unsupported KDBX KDF parameters")


class _ChaCha20Stream:
    """Continuous ChaCha20 keystream matching RFC 7539 / KDBX 4 InnerRandomStreamID=3."""

    def __init__(self, key32: bytes, nonce12: bytes) -> None:
        cipher = Cipher(algorithms.ChaCha20(key32, struct.pack("<I", 0) + nonce12), mode=None)
        self._ctx = cipher.encryptor()

    def xor(self, data: bytes) -> bytes:
        return self._ctx.update(data)


class _Salsa20Stream:
    """Continuous Salsa20 keystream matching KDBX 4 InnerRandomStreamID=2."""

    def __init__(self, key32: bytes, nonce8: bytes) -> None:
        self._key = key32
        self._nonce = nonce8
        self._counter = 0
        self._buf = b""

    def xor(self, data: bytes) -> bytes:
        if not data:
            return b""
        need = len(data)
        while len(self._buf) < need:
            self._buf += salsa20_xor(self._key, self._nonce, b"\x00" * 64, self._counter)
            self._counter += 1
        ks = self._buf[:need]
        self._buf = self._buf[need:]
        return bytes(a ^ b for a, b in zip(data, ks))


class Kdbx4Codec:
    """Clean-room KDBX 4.0 binary reader and writer."""

    @staticmethod
    def _outer_cipher(cipher_uuid: bytes, master_key: bytes, iv: bytes, encrypt: bool, data: bytes) -> bytes:
        if cipher_uuid == _CIPHER_CHACHA20:
            if len(iv) != 12:
                raise ValueError("ChaCha20 IV must be 12 bytes")
            cipher = Cipher(algorithms.ChaCha20(master_key, struct.pack("<I", 0) + iv), mode=None)
            ctx = cipher.encryptor() if encrypt else cipher.decryptor()
            return ctx.update(data) + ctx.finalize()
        if cipher_uuid == _CIPHER_AES256_CBC:
            if len(iv) != 16:
                raise ValueError("AES-256-CBC IV must be 16 bytes")
            cipher = Cipher(algorithms.AES(master_key), modes.CBC(iv))
            if encrypt:
                padder = sym_padding.PKCS7(128).padder()
                padded = padder.update(data) + padder.finalize()
                enc = cipher.encryptor()
                return enc.update(padded) + enc.finalize()
            dec = cipher.decryptor()
            padded = dec.update(data) + dec.finalize()
            unpadder = sym_padding.PKCS7(128).unpadder()
            return unpadder.update(padded) + unpadder.finalize()
        raise ValueError("Unsupported KDBX 4 cipher")

    @staticmethod
    def _build_inner_stream(stream_id: int, stream_key: bytes):
        if stream_id == 0:
            return None
        if stream_id == 2:
            return _Salsa20Stream(hashlib.sha256(stream_key).digest(), _SALSA20_IV)
        if stream_id == 3:
            h = hashlib.sha512(stream_key).digest()
            return _ChaCha20Stream(h[:32], h[32:44])
        raise ValueError(f"Unsupported inner stream cipher: {stream_id}")

    @classmethod
    def _decrypt_kdbx3(cls, raw_bytes: bytes, composite_key: bytes) -> tuple[etree._Element, list[tuple[int, bytes]]]:
        pos = 12
        headers: dict[int, bytes] = {}
        while pos < len(raw_bytes):
            fid = raw_bytes[pos]
            pos += 1
            flen = struct.unpack_from("<H", raw_bytes, pos)[0]
            pos += 2
            fdata = raw_bytes[pos : pos + flen]
            pos += flen
            headers[fid] = fdata
            if fid == 0:
                break

        master_seed = headers.get(4, b"")
        transform_seed = headers.get(5, b"")
        transform_rounds = struct.unpack("<Q", headers.get(6, struct.pack("<Q", 60000)))[0]
        transformed_key = _derive_kdf(
            composite_key,
            {"$UUID": _KDF_AES, "S": transform_seed, "R": transform_rounds},
        )
        master_key = hashlib.sha256(master_seed + transformed_key).digest()
        cipher_uuid = headers.get(2, _CIPHER_AES256_CBC)
        iv = headers.get(7, b"")
        try:
            decrypted = cls._outer_cipher(cipher_uuid, master_key, iv, encrypt=False, data=raw_bytes[pos:])
        except ValueError as exc:
            raise KeePassXCAuthError("Invalid master password.") from exc

        expected_start = headers.get(9, b"")
        if len(decrypted) < len(expected_start) or decrypted[: len(expected_start)] != expected_start:
            raise KeePassXCAuthError("Invalid master password.")

        bpos = len(expected_start)
        chunks: list[bytes] = []
        while bpos + 4 + 32 + 4 <= len(decrypted):
            _b_idx = struct.unpack_from("<I", decrypted, bpos)[0]
            bpos += 4
            b_hash = decrypted[bpos : bpos + 32]
            bpos += 32
            b_len = struct.unpack_from("<I", decrypted, bpos)[0]
            bpos += 4
            if b_len == 0:
                break
            b_data = decrypted[bpos : bpos + b_len]
            bpos += b_len
            if hashlib.sha256(b_data).digest() != b_hash:
                raise ValueError("KDBX 3 block SHA-256 verification failed")
            chunks.append(b_data)

        payload = b"".join(chunks)
        compression_flags = struct.unpack("<I", headers.get(3, struct.pack("<I", 1)))[0]
        if compression_flags == 1:
            payload = gzip.decompress(payload)

        root = etree.fromstring(payload, parser=_XML_PARSER)
        stream_id = struct.unpack("<I", headers.get(10, struct.pack("<I", 2)))[0]
        stream_key = headers.get(8, b"")
        stream = cls._build_inner_stream(stream_id, stream_key)
        if stream is not None:
            for val_el in root.iter("Value"):
                if val_el.get("Protected") == "True":
                    raw_ct = _b64d(val_el.text or "") if val_el.text else b""
                    pt = stream.xor(raw_ct).decode("utf-8")
                    val_el.text = pt
                    val_el.attrib.pop("Protected", None)
                    val_el.set("ProtectInMemory", "True")
        return root, []

    @classmethod
    def decrypt(cls, raw_bytes: bytes, composite_key: bytes) -> tuple[etree._Element, list[tuple[int, bytes]]]:
        if len(raw_bytes) < 12 + 64:
            raise ValueError("Invalid KDBX file: too short")
        sig1, sig2, ver = struct.unpack_from("<III", raw_bytes, 0)
        if sig1 != _KDBX_SIG1 or sig2 != _KDBX_SIG2:
            raise ValueError("Invalid KDBX signature")
        ver_major = ver & 0xFFFF0000
        if ver_major == _KDBX_VER_3:
            return cls._decrypt_kdbx3(raw_bytes, composite_key)
        if ver_major != _KDBX_VER_4:
            raise ValueError(f"Unsupported KDBX version: {hex(ver)} (expected KDBX 3.x or 4.x)")

        pos = 12
        headers: dict[int, bytes] = {}
        while pos < len(raw_bytes):
            fid = raw_bytes[pos]
            pos += 1
            flen = struct.unpack_from("<I", raw_bytes, pos)[0]
            pos += 4
            fdata = raw_bytes[pos : pos + flen]
            pos += flen
            headers[fid] = fdata
            if fid == 0:
                break
        raw_header = raw_bytes[:pos]

        expected_sha256 = raw_bytes[pos : pos + 32]
        pos += 32
        expected_hmac = raw_bytes[pos : pos + 32]
        pos += 32

        if hashlib.sha256(raw_header).digest() != expected_sha256:
            raise ValueError("KDBX header checksum mismatch")

        master_seed = headers.get(4, b"")
        kdf_params = _parse_variant_dict(headers.get(11, b""))
        transformed_key = _derive_kdf(composite_key, kdf_params)
        master_key = hashlib.sha256(master_seed + transformed_key).digest()
        hmac_seed = hashlib.sha512(master_seed + transformed_key + b"\x01").digest()
        header_hmac_key = hashlib.sha512(b"\xff" * 8 + hmac_seed).digest()
        actual_hmac = hmac.new(header_hmac_key, raw_header, hashlib.sha256).digest()
        if not hmac.compare_digest(actual_hmac, expected_hmac):
            raise KeePassXCAuthError("Invalid master password.")

        # Read HMAC-authenticated block stream
        encrypted_chunks: list[bytes] = []
        block_idx = 0
        while pos < len(raw_bytes):
            block_mac = raw_bytes[pos : pos + 32]
            pos += 32
            block_len = struct.unpack_from("<I", raw_bytes, pos)[0]
            pos += 4
            block_data = raw_bytes[pos : pos + block_len]
            pos += block_len
            block_key = hashlib.sha512(struct.pack("<Q", block_idx) + hmac_seed).digest()
            msg = struct.pack("<Q", block_idx) + struct.pack("<I", block_len) + block_data
            calc_mac = hmac.new(block_key, msg, hashlib.sha256).digest()
            if not hmac.compare_digest(calc_mac, block_mac):
                raise ValueError("KDBX payload block HMAC verification failed")
            if block_len == 0:
                break
            encrypted_chunks.append(block_data)
            block_idx += 1

        ciphertext = b"".join(encrypted_chunks)
        cipher_uuid = headers.get(2, _CIPHER_CHACHA20)
        iv = headers.get(7, b"")
        payload = cls._outer_cipher(cipher_uuid, master_key, iv, encrypt=False, data=ciphertext)

        compression_flags = struct.unpack("<I", headers.get(3, struct.pack("<I", 1)))[0]
        if compression_flags == 1:
            payload = gzip.decompress(payload)

        # Parse inner header
        ipos = 0
        inner_stream_id = 0
        inner_stream_key = b""
        preserved_inner_binaries: list[tuple[int, bytes]] = []
        while ipos < len(payload):
            ifid = payload[ipos]
            ipos += 1
            iflen = struct.unpack_from("<I", payload, ipos)[0]
            ipos += 4
            ifdata = payload[ipos : ipos + iflen]
            ipos += iflen
            if ifid == 0:
                break
            if ifid == 1:
                inner_stream_id = struct.unpack("<I", ifdata)[0]
            elif ifid == 2:
                inner_stream_key = ifdata
            elif ifid == 3:
                preserved_inner_binaries.append((ifid, ifdata))
            else:
                preserved_inner_binaries.append((ifid, ifdata))

        xml_bytes = payload[ipos:]
        root = etree.fromstring(xml_bytes, parser=_XML_PARSER)
        stream = cls._build_inner_stream(inner_stream_id, inner_stream_key)
        if stream is not None:
            for val_el in root.iter("Value"):
                if val_el.get("Protected") == "True":
                    raw_ct = _b64d(val_el.text or "") if val_el.text else b""
                    pt = stream.xor(raw_ct).decode("utf-8")
                    val_el.text = pt
                    val_el.attrib.pop("Protected", None)
                    val_el.set("ProtectInMemory", "True")
        return root, preserved_inner_binaries

    @classmethod
    def encrypt(
        cls,
        root: etree._Element,
        composite_key: bytes,
        *,
        argon2_memory_kib: int = 65536,
        argon2_iterations: int = 3,
        argon2_lanes: int = 2,
        preserved_inner_binaries: list[tuple[int, bytes]] | None = None,
    ) -> bytes:
        # Clone XML so we never mutate the unlocked in-memory tree's plaintext values
        xml_clone = etree.fromstring(etree.tostring(root, encoding="utf-8"), parser=_XML_PARSER)
        inner_key = os.urandom(64)
        inner_stream = cls._build_inner_stream(3, inner_key)
        assert inner_stream is not None

        for val_el in xml_clone.iter("Value"):
            parent = val_el.getparent()
            key_el = parent.find("Key") if parent is not None else None
            is_password_key = key_el is not None and (key_el.text or "") == "Password"
            should_protect = (
                val_el.get("Protected") == "True"
                or val_el.get("ProtectInMemory") == "True"
                or is_password_key
            )
            if should_protect:
                pt_bytes = (val_el.text or "").encode("utf-8")
                ct_bytes = inner_stream.xor(pt_bytes)
                val_el.attrib.pop("ProtectInMemory", None)
                val_el.set("Protected", "True")
                val_el.text = _b64e(ct_bytes) if ct_bytes else ""

        xml_bytes = etree.tostring(xml_clone, encoding="utf-8", xml_declaration=True, standalone=True)

        inner_buf = bytearray()
        for fid, fdata in (
            [(1, struct.pack("<I", 3)), (2, inner_key)]
            + list(preserved_inner_binaries or [])
            + [(0, b"")]
        ):
            inner_buf.append(fid)
            inner_buf.extend(struct.pack("<I", len(fdata)))
            inner_buf.extend(fdata)
        payload = gzip.compress(bytes(inner_buf) + xml_bytes, compresslevel=6)

        master_seed = os.urandom(32)
        iv = os.urandom(12)
        salt = os.urandom(32)
        kdf_bytes = _serialize_variant_dict([
            (0x42, "$UUID", _KDF_ARGON2ID),
            (0x42, "S", salt),
            (0x04, "P", argon2_lanes),
            (0x05, "M", max(8, argon2_memory_kib) * 1024),
            (0x05, "I", max(1, argon2_iterations)),
            (0x04, "V", 0x13),
        ])
        kdf_params = _parse_variant_dict(kdf_bytes)
        transformed_key = _derive_kdf(composite_key, kdf_params)
        master_key = hashlib.sha256(master_seed + transformed_key).digest()
        hmac_seed = hashlib.sha512(master_seed + transformed_key + b"\x01").digest()

        header_buf = bytearray(struct.pack("<III", _KDBX_SIG1, _KDBX_SIG2, _KDBX_VER_4))
        for fid, fdata in [
            (2, _CIPHER_CHACHA20),
            (3, struct.pack("<I", 1)),
            (4, master_seed),
            (7, iv),
            (11, kdf_bytes),
            (0, b"\r\n\r\n"),
        ]:
            header_buf.append(fid)
            header_buf.extend(struct.pack("<I", len(fdata)))
            header_buf.extend(fdata)
        raw_header = bytes(header_buf)

        header_sha256 = hashlib.sha256(raw_header).digest()
        header_hmac_key = hashlib.sha512(b"\xff" * 8 + hmac_seed).digest()
        header_hmac = hmac.new(header_hmac_key, raw_header, hashlib.sha256).digest()

        ciphertext = cls._outer_cipher(_CIPHER_CHACHA20, master_key, iv, encrypt=True, data=payload)
        blocks_buf = bytearray()
        block_idx = 0
        offset = 0
        while offset < len(ciphertext):
            chunk = ciphertext[offset : offset + _HMAC_BLOCK_SIZE]
            offset += len(chunk)
            block_key = hashlib.sha512(struct.pack("<Q", block_idx) + hmac_seed).digest()
            msg = struct.pack("<Q", block_idx) + struct.pack("<I", len(chunk)) + chunk
            mac = hmac.new(block_key, msg, hashlib.sha256).digest()
            blocks_buf.extend(mac)
            blocks_buf.extend(struct.pack("<I", len(chunk)))
            blocks_buf.extend(chunk)
            block_idx += 1
        # EOF 0-length block
        eof_key = hashlib.sha512(struct.pack("<Q", block_idx) + hmac_seed).digest()
        eof_msg = struct.pack("<Q", block_idx) + struct.pack("<I", 0)
        eof_mac = hmac.new(eof_key, eof_msg, hashlib.sha256).digest()
        blocks_buf.extend(eof_mac)
        blocks_buf.extend(struct.pack("<I", 0))

        return raw_header + header_sha256 + header_hmac + bytes(blocks_buf)


def _host_matches_entry(target_host: str, entry_host: str) -> bool:
    if not target_host or not entry_host:
        return False
    if target_host == entry_host:
        return True
    if target_host.endswith("." + entry_host):
        return True
    if entry_host.endswith("." + target_host):
        return True
    return False


def _is_internal_sanctuary_url(raw_url: str) -> bool:
    try:
        host = (urlparse(str(raw_url or "").strip()).hostname or "").lower()
    except Exception:
        return False
    return host == "lm-sanctuary.local" or host.endswith(".lm-sanctuary.local")


def _entry_strings(entry_el: etree._Element) -> dict[str, str]:
    out: dict[str, str] = {}
    for s_el in entry_el.findall("String"):
        k_el = s_el.find("Key")
        v_el = s_el.find("Value")
        if k_el is not None and k_el.text:
            out[k_el.text] = (v_el.text or "") if v_el is not None else ""
    return out


def _set_entry_string(entry_el: etree._Element, key: str, value: str, protect: bool = False) -> None:
    for s_el in entry_el.findall("String"):
        k_el = s_el.find("Key")
        if k_el is not None and k_el.text == key:
            v_el = s_el.find("Value")
            if v_el is None:
                v_el = etree.SubElement(s_el, "Value")
            v_el.text = value
            if protect:
                v_el.set("ProtectInMemory", "True")
            return
    s_el = etree.SubElement(entry_el, "String")
    k_el = etree.SubElement(s_el, "Key")
    k_el.text = key
    v_el = etree.SubElement(s_el, "Value")
    v_el.text = value
    if protect:
        v_el.set("ProtectInMemory", "True")


def _touch_entry_modified(entry_el: etree._Element) -> None:
    times_el = entry_el.find("Times")
    now_b64 = _utc_now_b64()
    if times_el is None:
        times_el = etree.SubElement(entry_el, "Times")
        etree.SubElement(times_el, "CreationTime").text = now_b64
        etree.SubElement(times_el, "LastModificationTime").text = now_b64
        etree.SubElement(times_el, "LastAccessTime").text = now_b64
        etree.SubElement(times_el, "LocationChanged").text = now_b64
        return
    mod_el = times_el.find("LastModificationTime")
    if mod_el is None:
        mod_el = etree.SubElement(times_el, "LastModificationTime")
    mod_el.text = now_b64


def _build_default_tree(db_name: str = "LM-Sanctuary Vault") -> etree._Element:
    root = etree.Element("KeePassFile")
    meta = etree.SubElement(root, "Meta")
    etree.SubElement(meta, "Generator").text = "LM-Sanctuary"
    etree.SubElement(meta, "DatabaseName").text = db_name
    etree.SubElement(meta, "DatabaseNameChanged").text = _utc_now_b64()
    etree.SubElement(meta, "RecycleBinEnabled").text = "True"
    recycle_uuid = _new_uuid_b64()
    etree.SubElement(meta, "RecycleBinUUID").text = recycle_uuid

    kp_root = etree.SubElement(root, "Root")
    root_group = etree.SubElement(kp_root, "Group")
    etree.SubElement(root_group, "UUID").text = _new_uuid_b64()
    etree.SubElement(root_group, "Name").text = db_name

    for group_name in ("Browser Logins", "LM-Sanctuary", "API Keys"):
        grp = etree.SubElement(root_group, "Group")
        etree.SubElement(grp, "UUID").text = _new_uuid_b64()
        etree.SubElement(grp, "Name").text = group_name

    return root


class InAppKeePassVault:
    """In-app KDBX 4.0 vault & KeePassXC-protocol credential service."""

    def __init__(
        self,
        data_dir: Path | None = None,
        on_lock_callback: Callable[[], None] | None = None,
        on_unlock_callback: Callable[[], None] | None = None,
        argon2_memory_kib: int = 65536,
        argon2_iterations: int = 3,
        argon2_lanes: int = 2,
    ) -> None:
        if data_dir is None:
            from utils import social_vault

            data_dir = social_vault.DATA_DIR
        self.data_dir = Path(data_dir)
        self._on_lock_callback = on_lock_callback
        self._on_unlock_callback = on_unlock_callback
        self._argon2_memory_kib = max(8, int(argon2_memory_kib))
        self._argon2_iterations = max(1, int(argon2_iterations))
        self._argon2_lanes = max(1, int(argon2_lanes))
        self._lock = threading.RLock()
        self._composite_key: bytearray | None = None
        self._tree: etree._Element | None = None
        self._preserved_inner_binaries: list[tuple[int, bytes]] = []
        self._loaded_stat: tuple[int, int] | None = None
        self._version = "KDBX 4.0"

    def _custom_path_config(self) -> Path:
        return self.data_dir / "kdbx_path.txt"

    def vault_path(self) -> Path:
        cfg = self._custom_path_config()
        if cfg.is_file():
            try:
                custom = cfg.read_text(encoding="utf-8").strip()
                if custom and custom.lower().endswith(".kdbx"):
                    return Path(custom)
            except OSError:
                pass
        return self.data_dir / "sanctuary.kdbx"

    def _stat_vault(self) -> tuple[int, int] | None:
        try:
            st_res = self.vault_path().stat()
            return (int(st_res.st_mtime_ns), int(st_res.st_size))
        except OSError:
            return None

    def _reload_if_external_change(self) -> None:
        if self._tree is None or self._composite_key is None or self._loaded_stat is None:
            return
        cur_stat = self._stat_vault()
        if cur_stat is None or cur_stat == self._loaded_stat:
            return
        try:
            raw = self.vault_path().read_bytes()
            tree, binaries = Kdbx4Codec.decrypt(raw, bytes(self._composite_key))
            self._tree = tree
            self._preserved_inner_binaries = binaries
            self._loaded_stat = cur_stat
        except Exception:
            pass

    def is_initialized(self) -> bool:
        return self.vault_path().is_file()

    def is_unlocked(self) -> bool:
        with self._lock:
            return self._tree is not None and self._composite_key is not None

    def _require_unlocked(self) -> tuple[etree._Element, bytearray]:
        if not self.is_initialized():
            raise KeePassXCAssociationError("Sanctuary Vault has not been set up yet.")
        if self._tree is None or self._composite_key is None:
            raise KeePassXCLockedError("Sanctuary Vault is locked. Enter your master password to unlock.")
        self._reload_if_external_change()
        return self._tree, self._composite_key

    def _compute_db_hash(self, tree: etree._Element) -> str:
        root_group = tree.find("./Root/Group")
        uuid_b64 = root_group.findtext("UUID") if root_group is not None else ""
        if uuid_b64:
            try:
                return hashlib.sha256(_b64d(uuid_b64)).hexdigest()
            except Exception:
                pass
        return hashlib.sha256(b"lm-sanctuary-kdbx4").hexdigest()

    def _recycle_bin_uuid_b64(self, tree: etree._Element) -> str:
        return (tree.findtext("./Meta/RecycleBinUUID") or "").strip()

    def _iter_active_entries(self, tree: etree._Element):
        recycle_uuid = self._recycle_bin_uuid_b64(tree)
        root_group = tree.find("./Root/Group")
        if root_group is None:
            return

        def walk(group_el: etree._Element, group_name: str):
            guuid = (group_el.findtext("UUID") or "").strip()
            if recycle_uuid and guuid == recycle_uuid:
                return
            for entry_el in group_el.findall("Entry"):
                yield group_name, entry_el
            for sub in group_el.findall("Group"):
                yield from walk(sub, (sub.findtext("Name") or "").strip())

        yield from walk(root_group, (root_group.findtext("Name") or "").strip())

    def _save_locked_tree(self) -> None:
        if self._tree is None or self._composite_key is None:
            raise KeePassXCLockedError("Sanctuary Vault is locked. Enter your master password to unlock.")
        tree, ckey = self._tree, self._composite_key
        self.data_dir.mkdir(parents=True, exist_ok=True)
        raw = Kdbx4Codec.encrypt(
            tree,
            bytes(ckey),
            argon2_memory_kib=self._argon2_memory_kib,
            argon2_iterations=self._argon2_iterations,
            argon2_lanes=self._argon2_lanes,
            preserved_inner_binaries=self._preserved_inner_binaries,
        )
        target = self.vault_path()
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_suffix(".kdbx.tmp")
        with tmp.open("wb") as f:
            f.write(raw)
        if os.name != "nt":
            tmp.chmod(0o600)
        try:
            os.replace(tmp, target)
        except PermissionError:
            target.write_bytes(raw)
            tmp.unlink(missing_ok=True)
        if os.name != "nt":
            target.chmod(0o600)
        self._loaded_stat = self._stat_vault()

    def create_vault(self, password: str, db_name: str = "LM-Sanctuary Vault") -> dict[str, Any]:
        with self._lock:
            if self.is_initialized():
                raise ValueError("Vault already exists. Unlock it instead.")
            ckey = composite_key_from_password(password)
            self._tree = _build_default_tree(db_name=db_name)
            self._composite_key = bytearray(ckey)
            self._preserved_inner_binaries = []
            self._save_locked_tree()
            db_hash = self._compute_db_hash(self._tree)
            if self._on_unlock_callback:
                try:
                    self._on_unlock_callback()
                except Exception:
                    pass
            return {"hash": db_hash, "version": self._version}

    def unlock(self, password: str) -> dict[str, Any]:
        with self._lock:
            if not self.is_initialized():
                raise KeePassXCAssociationError("Sanctuary Vault has not been set up yet.")
            ckey = composite_key_from_password(password)
            raw = self.vault_path().read_bytes()
            tree, binaries = Kdbx4Codec.decrypt(raw, ckey)
            if self._composite_key is not None:
                for i in range(len(self._composite_key)):
                    self._composite_key[i] = 0
            self._composite_key = bytearray(ckey)
            self._tree = tree
            self._preserved_inner_binaries = binaries
            self._loaded_stat = self._stat_vault()
            if self._on_unlock_callback:
                try:
                    self._on_unlock_callback()
                except Exception:
                    pass
            return self.get_status()

    def open_existing_vault(
        self,
        file_path: str | Path,
        password: str,
        carry_master_secret: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            clean_path = str(file_path or "").strip()
            if not clean_path:
                raise ValueError("Path to an existing .kdbx file is required.")
            target = Path(clean_path).expanduser().resolve()
            if not target.is_file() or not target.name.lower().endswith(".kdbx"):
                raise ValueError("Select a valid existing .kdbx file.")
            ckey = composite_key_from_password(password)
            tree, binaries = Kdbx4Codec.decrypt(target.read_bytes(), ckey)

            self.data_dir.mkdir(parents=True, exist_ok=True)
            default_target = (self.data_dir / "sanctuary.kdbx").resolve()
            cfg = self._custom_path_config()
            if target == default_target:
                cfg.unlink(missing_ok=True)
            else:
                cfg.write_text(str(target), encoding="utf-8")

            if self._composite_key is not None:
                for i in range(len(self._composite_key)):
                    self._composite_key[i] = 0
            self._composite_key = bytearray(ckey)
            self._tree = tree
            self._preserved_inner_binaries = binaries
            self._loaded_stat = self._stat_vault()

            if carry_master_secret and not self.get_logins(VAULT_MASTER_KEY_URL):
                self.set_login(
                    VAULT_MASTER_KEY_URL,
                    VAULT_MASTER_KEY_LOGIN,
                    carry_master_secret,
                    group="LM-Sanctuary",
                    title="LM-Sanctuary Vault Key",
                )

            if self._on_unlock_callback:
                try:
                    self._on_unlock_callback()
                except Exception:
                    pass
            return self.get_status()

    def _extract_master_key_from_tree(self, tree: etree._Element) -> str:
        fallback = ""
        for _gname, entry_el in self._iter_active_entries(tree):
            fields = _entry_strings(entry_el)
            if fields.get("URL", "").strip() != VAULT_MASTER_KEY_URL:
                continue
            secret = fields.get("Password", "")
            if not secret:
                continue
            if fields.get("UserName", "") == VAULT_MASTER_KEY_LOGIN:
                return secret
            if not fallback:
                fallback = secret
        return fallback

    def extract_master_key_from_file(self, file_path: str | Path, password: str) -> str:
        target = Path(file_path).expanduser().resolve()
        if not target.is_file() or not target.name.lower().endswith(".kdbx"):
            raise ValueError("Select a valid existing .kdbx file.")
        raw = target.read_bytes()
        tree, _binaries = Kdbx4Codec.decrypt(raw, composite_key_from_password(password))
        return self._extract_master_key_from_tree(tree)

    def ensure_vault_master_key(
        self,
        password: str = "",
        previous_vault_path: Path | None = None,
        previous_password: str = "",
    ) -> str:
        with self._lock:
            tree, _ckey = self._require_unlocked()
            existing = self._extract_master_key_from_tree(tree)
            if existing:
                return existing

            active_resolved = self.vault_path().resolve()
            donors: list[Path] = []
            for candidate in (previous_vault_path, self.data_dir / "sanctuary.kdbx"):
                if not candidate:
                    continue
                try:
                    resolved = Path(candidate).expanduser().resolve()
                except OSError:
                    continue
                if resolved != active_resolved and resolved.is_file() and resolved not in donors:
                    donors.append(resolved)

            pw_candidates = [pw for pw in (previous_password, password) if pw]
            for donor in donors:
                donor_had_auth_error = False
                donor_unlocked = False
                for pw in pw_candidates:
                    try:
                        secret = self.extract_master_key_from_file(donor, pw)
                        donor_unlocked = True
                        if secret:
                            self.set_login(
                                VAULT_MASTER_KEY_URL,
                                VAULT_MASTER_KEY_LOGIN,
                                secret,
                                group="LM-Sanctuary",
                                title="LM-Sanctuary Vault Key",
                            )
                            return secret
                        break
                    except KeePassXCAuthError:
                        donor_had_auth_error = True
                    except Exception:
                        break
                if donor_had_auth_error and not donor_unlocked:
                    from utils import social_vault

                    if social_vault.is_keepassxc_vault_enabled():
                        raise KeePassXCMigrationPasswordError(
                            "Enter the master password for your previous Sanctuary vault to migrate your encryption key."
                        )
            return ""

    def lock_database(self) -> None:
        with self._lock:
            if self._composite_key is not None:
                for i in range(len(self._composite_key)):
                    self._composite_key[i] = 0
            self._composite_key = None
            self._tree = None
            self._preserved_inner_binaries = []
            self._loaded_stat = None
        if self._on_lock_callback:
            try:
                self._on_lock_callback()
            except Exception:
                pass

    def change_password(self, current_password: str, new_password: str) -> dict[str, Any]:
        with self._lock:
            self.unlock(current_password)
            new_ckey = composite_key_from_password(new_password)
            if self._composite_key is not None:
                for i in range(len(self._composite_key)):
                    self._composite_key[i] = 0
            self._composite_key = bytearray(new_ckey)
            self._save_locked_tree()
            return self.get_status()

    def get_database_hash(self, trigger_unlock: bool = False, timeout: float = 0) -> tuple[str, str]:
        with self._lock:
            tree, _ckey = self._require_unlocked()
            return self._compute_db_hash(tree), self._version

    def _find_or_create_group(self, tree: etree._Element, group_name: str) -> etree._Element:
        clean = str(group_name or "").strip() or "Browser Logins"
        root_group = tree.find("./Root/Group")
        if root_group is None:
            kp_root = tree.find("./Root") or etree.SubElement(tree, "Root")
            root_group = etree.SubElement(kp_root, "Group")
            etree.SubElement(root_group, "UUID").text = _new_uuid_b64()
            etree.SubElement(root_group, "Name").text = "LM-Sanctuary Vault"

        def search(parent: etree._Element) -> etree._Element | None:
            for g in parent.findall("Group"):
                if (g.findtext("Name") or "").strip().lower() == clean.lower():
                    return g
                nested = search(g)
                if nested is not None:
                    return nested
            return None

        found = search(root_group)
        if found is not None:
            return found
        created = etree.SubElement(root_group, "Group")
        etree.SubElement(created, "UUID").text = _new_uuid_b64()
        etree.SubElement(created, "Name").text = clean
        return created

    def create_new_group(self, group_name: str) -> dict[str, str]:
        with self._lock:
            tree, _ckey = self._require_unlocked()
            grp = self._find_or_create_group(tree, group_name)
            self._save_locked_tree()
            return {
                "name": (grp.findtext("Name") or group_name).strip(),
                "uuid": _uuid_b64_to_hex(grp.findtext("UUID") or ""),
            }

    def set_login(
        self,
        url: str,
        login: str,
        password: str,
        submit_url: str = "",
        entry_uuid: str = "",
        group: str = "Browser Logins",
        group_uuid: str = "",
        title: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            tree, _ckey = self._require_unlocked()
            clean_url = str(url or "").strip()
            clean_login = str(login or "").strip()
            clean_uuid = str(entry_uuid or "").strip().lower()

            target_entry: etree._Element | None = None
            for _gname, entry_el in self._iter_active_entries(tree):
                euuid = _uuid_b64_to_hex(entry_el.findtext("UUID") or "")
                if clean_uuid and euuid == clean_uuid:
                    target_entry = entry_el
                    break
                fields = _entry_strings(entry_el)
                if fields.get("URL", "") == clean_url and fields.get("UserName", "") == clean_login:
                    target_entry = entry_el
                    break

            if target_entry is None:
                parent_group = self._find_or_create_group(tree, group or "Browser Logins")
                target_entry = etree.SubElement(parent_group, "Entry")
                new_uuid = _new_uuid_b64()
                etree.SubElement(target_entry, "UUID").text = new_uuid
                clean_uuid = _uuid_b64_to_hex(new_uuid)
            else:
                clean_uuid = _uuid_b64_to_hex(target_entry.findtext("UUID") or "")

            resolved_title = str(title or "").strip()
            if not resolved_title:
                parsed = urlparse(clean_url)
                resolved_title = parsed.hostname or clean_login or "Login"

            _set_entry_string(target_entry, "Title", resolved_title, protect=False)
            _set_entry_string(target_entry, "UserName", clean_login, protect=False)
            _set_entry_string(target_entry, "Password", str(password or ""), protect=True)
            _set_entry_string(target_entry, "URL", clean_url, protect=False)
            self._save_locked_tree()
            return {"uuid": clean_uuid, "hash": self._compute_db_hash(tree)}

    def get_logins(
        self,
        url: str,
        submit_url: str = "",
        trigger_unlock: bool = False,
        timeout: float = 0,
    ) -> list[dict[str, str]]:
        with self._lock:
            tree, _ckey = self._require_unlocked()
            clean_url = str(url or "").strip()
            target_host = (urlparse(clean_url).hostname or "").lower()
            querying_internal = _is_internal_sanctuary_url(clean_url)

            results: list[dict[str, str]] = []
            for _gname, entry_el in self._iter_active_entries(tree):
                fields = _entry_strings(entry_el)
                entry_url = fields.get("URL", "").strip()
                if not entry_url:
                    continue
                if querying_internal:
                    if entry_url != clean_url:
                        continue
                else:
                    if _is_internal_sanctuary_url(entry_url):
                        continue
                    entry_host = (urlparse(entry_url).hostname or "").lower()
                    if not _host_matches_entry(target_host, entry_host):
                        continue
                results.append({
                    "uuid": _uuid_b64_to_hex(entry_el.findtext("UUID") or ""),
                    "name": fields.get("Title", "") or fields.get("UserName", ""),
                    "login": fields.get("UserName", ""),
                    "password": fields.get("Password", ""),
                    "url": entry_url,
                })
            return results

    def get_secret(self, key_name: str) -> str:
        clean_key = str(key_name or "").strip()
        if not clean_key:
            return ""
        internal_url = f"https://lm-sanctuary.local/api-keys/{clean_key}"
        entries = self.get_logins(internal_url)
        return entries[0]["password"] if entries else ""

    def set_secret(self, key_name: str, secret_value: str, title: str = "") -> None:
        clean_key = str(key_name or "").strip()
        if not clean_key:
            raise ValueError("API key name is required.")
        internal_url = f"https://lm-sanctuary.local/api-keys/{clean_key}"
        clean_secret = str(secret_value or "")
        with self._lock:
            tree, _ckey = self._require_unlocked()
            if not clean_secret:
                for _gname, entry_el in list(self._iter_active_entries(tree)):
                    fields = _entry_strings(entry_el)
                    if fields.get("URL", "").strip() == internal_url:
                        parent = entry_el.getparent()
                        if parent is not None:
                            parent.remove(entry_el)
                self._save_locked_tree()
                return
            self.set_login(
                internal_url,
                clean_key,
                clean_secret,
                group="API Keys",
                title=title or clean_key,
            )

    def _list_group_names(self, tree: etree._Element) -> list[str]:
        recycle_uuid = self._recycle_bin_uuid_b64(tree)
        root_group = tree.find("./Root/Group")
        names: list[str] = []
        seen: set[str] = set()

        def add_name(raw_name: str) -> None:
            clean = str(raw_name or "").strip()
            if clean and clean.lower() not in seen:
                seen.add(clean.lower())
                names.append(clean)

        if root_group is not None:
            subgroups = root_group.findall("Group")
            if not subgroups:
                add_name(root_group.findtext("Name") or "")

            def walk(group_el: etree._Element) -> None:
                guuid = (group_el.findtext("UUID") or "").strip()
                if recycle_uuid and guuid == recycle_uuid:
                    return
                add_name(group_el.findtext("Name") or "")
                for sub in group_el.findall("Group"):
                    walk(sub)

            for sub in subgroups:
                walk(sub)

        for default_name in ("Browser Logins", "API Keys"):
            add_name(default_name)
        return names

    def list_entries_summary(self) -> dict[str, Any]:
        with self._lock:
            tree, _ckey = self._require_unlocked()
            logins: list[dict[str, str]] = []
            api_keys: list[dict[str, str]] = []
            entries: list[dict[str, Any]] = []
            for gname, entry_el in self._iter_active_entries(tree):
                fields = _entry_strings(entry_el)
                entry_url = fields.get("URL", "").strip()
                if entry_url == VAULT_MASTER_KEY_URL:
                    continue
                euuid = _uuid_b64_to_hex(entry_el.findtext("UUID") or "")
                title = fields.get("Title", "").strip()
                username = fields.get("UserName", "").strip()
                password = fields.get("Password", "")
                notes = fields.get("Notes", "")
                is_api_key = entry_url.startswith("https://lm-sanctuary.local/api-keys/")
                if is_api_key:
                    key_name = entry_url[len("https://lm-sanctuary.local/api-keys/") :]
                    masked = (
                        f"{password[:4]}…{password[-3:]}" if len(password) > 8 else ("••••" if password else "")
                    )
                    api_keys.append({
                        "uuid": euuid,
                        "key_name": key_name,
                        "name": title or key_name,
                        "masked_preview": masked,
                    })
                    entries.append({
                        "uuid": euuid,
                        "title": title or key_name,
                        "name": title or key_name,
                        "login": key_name,
                        "url": "",
                        "group": gname or "API Keys",
                        "notes_preview": notes[:140],
                        "has_password": bool(password),
                        "kind": "api_key",
                        "key_name": key_name,
                    })
                elif not _is_internal_sanctuary_url(entry_url):
                    display_title = title or username or entry_url or "Untitled Entry"
                    logins.append({
                        "uuid": euuid,
                        "name": display_title,
                        "login": username,
                        "url": entry_url,
                    })
                    entries.append({
                        "uuid": euuid,
                        "title": display_title,
                        "name": display_title,
                        "login": username,
                        "url": entry_url,
                        "group": gname or "Browser Logins",
                        "notes_preview": notes[:140],
                        "has_password": bool(password),
                        "kind": "login",
                        "key_name": "",
                    })
            return {
                "entries": entries,
                "groups": self._list_group_names(tree),
                "logins": logins,
                "api_keys": api_keys,
            }

    def get_entry(self, entry_uuid: str) -> dict[str, Any]:
        clean_uuid = str(entry_uuid or "").strip().lower()
        if not clean_uuid:
            raise ValueError("Entry UUID is required.")
        with self._lock:
            tree, _ckey = self._require_unlocked()
            for gname, entry_el in self._iter_active_entries(tree):
                euuid = _uuid_b64_to_hex(entry_el.findtext("UUID") or "")
                if euuid != clean_uuid:
                    continue
                fields = _entry_strings(entry_el)
                entry_url = fields.get("URL", "").strip()
                if entry_url == VAULT_MASTER_KEY_URL:
                    raise ValueError("Cannot inspect internal vault master key.")
                is_api_key = entry_url.startswith("https://lm-sanctuary.local/api-keys/")
                key_name = entry_url[len("https://lm-sanctuary.local/api-keys/") :] if is_api_key else ""
                if not is_api_key and _is_internal_sanctuary_url(entry_url):
                    raise ValueError("Cannot inspect internal Sanctuary entry.")
                return {
                    "uuid": euuid,
                    "title": fields.get("Title", ""),
                    "login": key_name if is_api_key else fields.get("UserName", ""),
                    "password": fields.get("Password", ""),
                    "url": "" if is_api_key else entry_url,
                    "notes": fields.get("Notes", ""),
                    "group": gname or ("API Keys" if is_api_key else "Browser Logins"),
                    "kind": "api_key" if is_api_key else "login",
                    "key_name": key_name,
                }
            raise KeyError("Entry not found.")

    def save_entry(
        self,
        *,
        entry_uuid: str = "",
        title: str = "",
        login: str = "",
        password: str | None = None,
        url: str = "",
        notes: str = "",
        group: str = "",
        kind: str = "login",
        key_name: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            tree, _ckey = self._require_unlocked()
            clean_uuid = str(entry_uuid or "").strip().lower()
            target_entry: etree._Element | None = None
            current_group = ""
            if clean_uuid:
                for gname, entry_el in self._iter_active_entries(tree):
                    if _uuid_b64_to_hex(entry_el.findtext("UUID") or "") == clean_uuid:
                        target_entry = entry_el
                        current_group = gname
                        break
                if target_entry is None:
                    raise KeyError("Entry not found.")
                existing_fields = _entry_strings(target_entry)
                existing_url = existing_fields.get("URL", "").strip()
                if existing_url == VAULT_MASTER_KEY_URL:
                    raise ValueError("Cannot modify the Sanctuary Vault master key entry.")
                if existing_url.startswith("https://lm-sanctuary.local/api-keys/"):
                    kind = "api_key"

            clean_kind = "api_key" if kind == "api_key" else "login"
            clean_title = str(title or "").strip()
            clean_notes = str(notes or "")

            if clean_kind == "api_key":
                resolved_key = str(key_name or login or clean_title).strip()
                if not resolved_key:
                    raise ValueError("API key name is required.")
                resolved_url = f"https://lm-sanctuary.local/api-keys/{resolved_key}"
                resolved_login = resolved_key
                default_group = "API Keys"
                resolved_title = clean_title or resolved_key
            else:
                resolved_url = str(url or "").strip()
                lower_url = resolved_url.lower()
                if _is_internal_sanctuary_url(resolved_url) or lower_url.startswith(("javascript:", "data:")):
                    raise ValueError("Invalid entry URL.")
                resolved_login = str(login or "").strip()
                default_group = "Browser Logins"
                if not (clean_title or resolved_login or resolved_url):
                    raise ValueError("Title, username, or URL is required.")
                parsed_host = (urlparse(resolved_url).hostname or "") if resolved_url else ""
                resolved_title = clean_title or parsed_host or resolved_login or resolved_url

            target_group_name = str(group or "").strip() or current_group or default_group
            if target_entry is None:
                parent_group = self._find_or_create_group(tree, target_group_name)
                target_entry = etree.SubElement(parent_group, "Entry")
                new_uuid = _new_uuid_b64()
                etree.SubElement(target_entry, "UUID").text = new_uuid
                clean_uuid = _uuid_b64_to_hex(new_uuid)
            elif target_group_name.lower() != current_group.lower():
                old_parent = target_entry.getparent()
                new_parent = self._find_or_create_group(tree, target_group_name)
                if old_parent is not None and new_parent is not old_parent:
                    old_parent.remove(target_entry)
                    new_parent.append(target_entry)

            _set_entry_string(target_entry, "Title", resolved_title, protect=False)
            _set_entry_string(target_entry, "UserName", resolved_login, protect=False)
            if password is not None:
                _set_entry_string(target_entry, "Password", str(password), protect=True)
            _set_entry_string(target_entry, "URL", resolved_url, protect=False)
            _set_entry_string(target_entry, "Notes", clean_notes, protect=False)
            _touch_entry_modified(target_entry)

            self._save_locked_tree()
            return self.get_entry(clean_uuid)

    def delete_entry(self, entry_uuid: str) -> bool:
        clean_uuid = str(entry_uuid or "").strip().lower()
        if not clean_uuid:
            return False
        with self._lock:
            tree, _ckey = self._require_unlocked()
            for _gname, entry_el in list(self._iter_active_entries(tree)):
                if _uuid_b64_to_hex(entry_el.findtext("UUID") or "") == clean_uuid:
                    fields = _entry_strings(entry_el)
                    if fields.get("URL", "").strip() == VAULT_MASTER_KEY_URL:
                        raise ValueError("Cannot delete the Sanctuary Vault master key entry.")
                    parent = entry_el.getparent()
                    if parent is not None:
                        parent.remove(entry_el)
                    self._save_locked_tree()
                    return True
            return False

    def export_kdbx_bytes(self) -> bytes:
        with self._lock:
            self._require_unlocked()
            self._save_locked_tree()
            return self.vault_path().read_bytes()

    def import_kdbx_bytes(
        self,
        raw_bytes: bytes,
        import_password: str,
        master_password: str = "",
    ) -> dict[str, Any]:
        with self._lock:
            import_ckey = composite_key_from_password(import_password)
            imported_tree, imported_bins = Kdbx4Codec.decrypt(raw_bytes, import_ckey)
            if not self.is_initialized():
                final_ckey = composite_key_from_password(master_password or import_password)
                self._tree = imported_tree
                self._composite_key = bytearray(final_ckey)
                self._preserved_inner_binaries = imported_bins
                self._find_or_create_group(self._tree, "Browser Logins")
                self._find_or_create_group(self._tree, "LM-Sanctuary")
                self._find_or_create_group(self._tree, "API Keys")
                self._save_locked_tree()
                if self._on_unlock_callback:
                    try:
                        self._on_unlock_callback()
                    except Exception:
                        pass
                return {"imported": len(list(self._iter_active_entries(self._tree))), "created": True}

            tree, _ckey = self._require_unlocked()
            existing_uuids = {
                _uuid_b64_to_hex(e.findtext("UUID") or "")
                for _g, e in self._iter_active_entries(tree)
            }
            existing_pairs = {
                (_entry_strings(e).get("URL", ""), _entry_strings(e).get("UserName", ""))
                for _g, e in self._iter_active_entries(tree)
            }
            imported_count = 0
            for gname, entry_el in self._iter_active_entries(imported_tree):
                euuid = _uuid_b64_to_hex(entry_el.findtext("UUID") or "")
                fields = _entry_strings(entry_el)
                pair = (fields.get("URL", ""), fields.get("UserName", ""))
                if euuid in existing_uuids or (pair[0] and pair in existing_pairs):
                    continue
                target_grp = self._find_or_create_group(tree, gname or "Browser Logins")
                cloned = etree.fromstring(etree.tostring(entry_el, encoding="utf-8"), parser=_XML_PARSER)
                target_grp.append(cloned)
                existing_uuids.add(euuid)
                existing_pairs.add(pair)
                imported_count += 1
            if imported_count > 0:
                self._save_locked_tree()
            return {"imported": imported_count, "created": False}

    def get_status(self) -> dict[str, Any]:
        with self._lock:
            initialized = self.is_initialized()
            unlocked = self.is_unlocked()
            vpath = self.vault_path()
            db_hash = self._compute_db_hash(self._tree) if (unlocked and self._tree is not None) else ""
            entry_count = 0
            if unlocked and self._tree is not None:
                self._reload_if_external_change()
                for _g, e in self._iter_active_entries(self._tree):
                    u = _entry_strings(e).get("URL", "").strip()
                    if u != VAULT_MASTER_KEY_URL:
                        entry_count += 1
            return {
                "provider": "sanctuary-kdbx",
                "installed": True,
                "running": True,
                "initialized": initialized,
                "associated": initialized,
                "database_unlocked": unlocked,
                "database_hash": db_hash,
                "version": self._version,
                "entry_count": entry_count,
                "vault_path": str(vpath),
                "vault_filename": vpath.name,
            }

    def close(self) -> None:
        self.lock_database()


KeePassXCBridge = InAppKeePassVault

_BRIDGE_LOCK = threading.Lock()
_DEFAULT_BRIDGE: InAppKeePassVault | None = None


def get_keepassxc_bridge() -> InAppKeePassVault:
    global _DEFAULT_BRIDGE
    with _BRIDGE_LOCK:
        if _DEFAULT_BRIDGE is None:
            from utils import social_vault

            _DEFAULT_BRIDGE = InAppKeePassVault(
                data_dir=social_vault.DATA_DIR,
                on_lock_callback=social_vault.clear_cached_vault_key,
            )
        return _DEFAULT_BRIDGE
