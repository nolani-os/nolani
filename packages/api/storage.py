"""Object storage abstraction: S3-compatible instead of local paths.

12-factor building block: first-party apps store files (attachments, uploads,
exports) through this interface. The backend is swappable via env — Garage
(claraos-s3) on the home server by default, any S3 service elsewhere. NO code
outside this file may know S3 details or local storage paths.

Key convention (prepared for tenancy):
    t{tenant_id}/{app}/{object-path}
    e.g. t1/knowledge/pages/42/attachment.pdf
"""

from betriebsprofil import heim_default  # external cell: no silent home fallback
import os
from functools import lru_cache

import boto3
from botocore.client import Config

S3_ENDPOINT = heim_default("S3_ENDPOINT")
S3_REGION = os.environ.get("S3_REGION", "claraos")
S3_BUCKET = os.environ.get("S3_BUCKET", "claraos-attachments")


@lru_cache(maxsize=1)
def _client():
    return boto3.client(
        "s3",
        endpoint_url=S3_ENDPOINT,
        region_name=S3_REGION,
        aws_access_key_id=os.environ["S3_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["S3_SECRET_ACCESS_KEY"],
        # Garage: path-style, no checksum trailers (most compatible mode)
        config=Config(s3={"addressing_style": "path"}, signature_version="s3v4"),
    )


def object_key(tenant_id: int, app: str, path: str) -> str:
    """Canonical object key — the tenant prefix is mandatory."""
    return f"t{int(tenant_id)}/{app}/{path.lstrip('/')}"


def put_object(key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    _client().put_object(Bucket=S3_BUCKET, Key=key, Body=data, ContentType=content_type)


def get_object(key: str) -> bytes:
    return _client().get_object(Bucket=S3_BUCKET, Key=key)["Body"].read()


def delete_object(key: str) -> None:
    _client().delete_object(Bucket=S3_BUCKET, Key=key)


def object_exists(key: str) -> bool:
    try:
        _client().head_object(Bucket=S3_BUCKET, Key=key)
        return True
    except _client().exceptions.ClientError:
        return False


def list_keys(prefix: str, limit: int = 1000) -> list[str]:
    resp = _client().list_objects_v2(Bucket=S3_BUCKET, Prefix=prefix, MaxKeys=limit)
    return [o["Key"] for o in resp.get("Contents", [])]


def health() -> bool:
    """For /health checks: is the bucket reachable?"""
    try:
        _client().head_bucket(Bucket=S3_BUCKET)
        return True
    except Exception:
        return False
