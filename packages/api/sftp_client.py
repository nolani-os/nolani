"""Async SFTP client for remote file operations on connected devices."""

import os
import shlex
import stat
import logging
from typing import Optional

import asyncssh

logger = logging.getLogger(__name__)

SSH_KEY_PATH = os.environ.get("SSH_KEY_PATH", "/ssh/claraos_ed25519")


async def _connect(host: str, port: int, user: str, key_path: Optional[str] = None):
    """Create SSH connection with SFTP subsystem."""
    kp = key_path or SSH_KEY_PATH
    keys = [kp] if os.path.exists(kp) else []
    # Try MCP key as fallback
    mcp_key = "/ssh_mcp/id_ed25519"
    if os.path.exists(mcp_key) and mcp_key not in keys:
        keys.append(mcp_key)
    return await asyncssh.connect(
        host, port=port, username=user,
        client_keys=keys, known_hosts=None, connect_timeout=10,
    )


async def list_dir(host: str, port: int, user: str, path: str = "/",
                   key_path: Optional[str] = None) -> list[dict]:
    """List directory contents via SFTP, with SSH ls fallback."""
    async with await _connect(host, port, user, key_path) as conn:
        try:
            async with conn.start_sftp_client() as sftp:
                entries = []
                for entry in await sftp.readdir(path):
                    name = entry.filename
                    if name in (".", ".."):
                        continue
                    attrs = entry.attrs
                    is_dir = stat.S_ISDIR(attrs.permissions) if attrs.permissions else False
                    node = {
                        "name": name,
                        "path": f"{path.rstrip('/')}/{name}",
                        "isDir": is_dir,
                    }
                    if not is_dir and attrs.size is not None:
                        node["size"] = attrs.size
                    if attrs.mtime is not None:
                        from datetime import datetime, timezone
                        node["modified"] = datetime.fromtimestamp(attrs.mtime, tz=timezone.utc).isoformat()
                    entries.append(node)
                entries.sort(key=lambda n: (not n["isDir"], n["name"].lower()))
                return entries
        except (asyncssh.SFTPError, asyncssh.ChannelOpenError, Exception) as e:
            logger.warning("SFTP failed for %s, falling back to SSH ls: %s", host, e)
            return await _ssh_ls_fallback(conn, path)


async def _ssh_ls_fallback(conn, path: str) -> list[dict]:
    """Fallback: list directory via SSH 'ls -la' when SFTP is unavailable."""
    result = await conn.run(f"ls -la -- {shlex.quote(path)} 2>/dev/null", check=False)
    entries = []
    for line in (result.stdout or "").splitlines()[1:]:  # skip "total" line
        parts = line.split(None, 8)
        if len(parts) < 9:
            continue
        perms, _, _, _, size_str, _, _, _, name = parts
        if name in (".", ".."):
            continue
        is_dir = perms.startswith("d")
        node = {
            "name": name,
            "path": f"{path.rstrip('/')}/{name}",
            "isDir": is_dir,
        }
        try:
            node["size"] = int(size_str)
        except ValueError:
            pass
        entries.append(node)
    entries.sort(key=lambda n: (not n["isDir"], n["name"].lower()))
    return entries


async def _try_sftp_or_ssh(host, port, user, key_path, sftp_fn, ssh_fn):
    """Try SFTP first, fall back to SSH commands."""
    async with await _connect(host, port, user, key_path) as conn:
        try:
            async with conn.start_sftp_client() as sftp:
                return await sftp_fn(sftp)
        except (asyncssh.SFTPError, asyncssh.ChannelOpenError, Exception) as e:
            logger.warning("SFTP unavailable for %s, using SSH fallback: %s", host, e)
            return await ssh_fn(conn)


async def read_file(host: str, port: int, user: str, path: str,
                    key_path: Optional[str] = None, max_size: int = 10 * 1024 * 1024) -> bytes:
    """Read a file via SFTP (with SSH cat fallback). Returns raw bytes."""
    async def _sftp(sftp):
        attrs = await sftp.stat(path)
        if attrs.size and attrs.size > max_size:
            raise ValueError(f"File too large: {attrs.size} bytes (max {max_size})")
        async with sftp.open(path, "rb") as f:
            return await f.read()

    async def _ssh(conn):
        result = await conn.run(f"cat -- {shlex.quote(path)}", check=True, encoding=None)
        return result.stdout

    return await _try_sftp_or_ssh(host, port, user, key_path, _sftp, _ssh)


async def write_file(host: str, port: int, user: str, path: str,
                     content: bytes, key_path: Optional[str] = None) -> int:
    """Write content to a file via SFTP (with SSH fallback). Returns bytes written."""
    import base64 as _b64

    async def _sftp(sftp):
        async with sftp.open(path, "wb") as f:
            await f.write(content)
        return len(content)

    async def _ssh(conn):
        b64 = _b64.b64encode(content).decode()
        await conn.run(f"base64 -d > {shlex.quote(path)}", input=b64, check=True)
        return len(content)

    return await _try_sftp_or_ssh(host, port, user, key_path, _sftp, _ssh)


async def stream_file(host: str, port: int, user: str, path: str,
                      key_path: Optional[str] = None, chunk: int = 256 * 1024):
    """Read a file in chunks (download without a size limit)."""
    async with await _connect(host, port, user, key_path) as conn:
        async with conn.start_sftp_client() as sftp:
            async with sftp.open(path, "rb") as f:
                while True:
                    block = await f.read(chunk)
                    if not block:
                        break
                    yield block


async def write_stream(host: str, port: int, user: str, path: str, blocks,
                       key_path: Optional[str] = None) -> int:
    """Write a file from an async iterator (upload without a size limit)."""
    total = 0
    async with await _connect(host, port, user, key_path) as conn:
        async with conn.start_sftp_client() as sftp:
            async with sftp.open(path, "wb") as f:
                async for block in blocks:
                    await f.write(block)
                    total += len(block)
    return total


async def mkdir(host: str, port: int, user: str, path: str,
                key_path: Optional[str] = None) -> None:
    """Create a directory via SFTP (with SSH fallback)."""
    async def _sftp(sftp):
        try:
            await sftp.mkdir(path)
        except asyncssh.SFTPFailure:
            pass

    async def _ssh(conn):
        await conn.run(f"mkdir -p -- {shlex.quote(path)}", check=False)

    await _try_sftp_or_ssh(host, port, user, key_path, _sftp, _ssh)


async def delete(host: str, port: int, user: str, path: str,
                 key_path: Optional[str] = None) -> None:
    """Delete a file or directory via SFTP (with SSH fallback)."""
    async def _sftp(sftp):
        attrs = await sftp.stat(path)
        if stat.S_ISDIR(attrs.permissions):
            await _rmdir_recursive(sftp, path)
        else:
            await sftp.remove(path)

    async def _ssh(conn):
        await conn.run(f"rm -rf -- {shlex.quote(path)}", check=True)

    await _try_sftp_or_ssh(host, port, user, key_path, _sftp, _ssh)


async def kind(host: str, port: int, user: str, path: str,
               key_path: Optional[str] = None) -> Optional[str]:
    """'dir' · 'file' · None (does not exist) — for conflict checks before copy/move."""
    async def _sftp(sftp):
        try:
            attrs = await sftp.stat(path)
        except asyncssh.SFTPNoSuchFile:
            return None
        return "dir" if stat.S_ISDIR(attrs.permissions) else "file"

    async def _ssh(conn):
        q = shlex.quote(path)
        r = await conn.run(f"if [ -d {q} ]; then echo dir; elif [ -e {q} ]; then echo file; fi", check=False)
        return (r.stdout or "").strip() or None

    return await _try_sftp_or_ssh(host, port, user, key_path, _sftp, _ssh)


async def rename(host: str, port: int, user: str, src: str, dst: str,
                 key_path: Optional[str] = None) -> None:
    """Rename / move a file or directory via SFTP (with SSH fallback)."""
    async def _sftp(sftp):
        await sftp.rename(src, dst)

    async def _ssh(conn):
        await conn.run(f"mv -- {shlex.quote(src)} {shlex.quote(dst)}", check=True)

    await _try_sftp_or_ssh(host, port, user, key_path, _sftp, _ssh)


async def _rmdir_recursive(sftp, path: str):
    """Recursively delete a directory."""
    for entry in await sftp.readdir(path):
        if entry.filename in (".", ".."):
            continue
        child = f"{path.rstrip('/')}/{entry.filename}"
        if stat.S_ISDIR(entry.attrs.permissions):
            await _rmdir_recursive(sftp, child)
        else:
            await sftp.remove(child)
    await sftp.rmdir(path)


async def copy_between(
    src_host: str, src_port: int, src_user: str, src_path: str,
    dst_host: str, dst_port: int, dst_user: str, dst_path: str,
    src_key: Optional[str] = None, dst_key: Optional[str] = None,
) -> int:
    """Copy a file between two SFTP hosts. Returns bytes transferred."""
    # Read from source
    data = await read_file(src_host, src_port, src_user, src_path, key_path=src_key)
    # Write to destination
    return await write_file(dst_host, dst_port, dst_user, dst_path, data, key_path=dst_key)
