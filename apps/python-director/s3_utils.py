"""
s3_utils.py — AWS S3 helper for director save uploads.

Graceful degradation: if boto3 is not installed or credentials are missing,
all functions return False without raising exceptions.
"""

import os
import logging

logger = logging.getLogger(__name__)

S3_BUCKET      = os.getenv("S3_BUCKET", "")
S3_LORE_BUCKET = os.getenv("S3_LORE_BUCKET", "starship-lore-docs-131677314808")
AWS_REGION     = os.getenv("AWS_REGION", "us-east-1")

try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError
    _boto3_available = True
except ImportError:
    _boto3_available = False
    logger.warning("[S3] boto3 not installed — S3 upload disabled")


def _get_client():
    if not _boto3_available:
        return None
    try:
        return boto3.client("s3", region_name=AWS_REGION)
    except Exception as e:
        logger.error(f"[S3] Failed to create boto3 client: {e}")
        return None


def upload_save(local_path: str, slot: str) -> bool:
    """
    Upload a local JSON save file to S3.

    Args:
        local_path: Absolute path to the local .json file.
        slot:       Save slot name (used as S3 key prefix).

    Returns:
        True on success, False on any failure.
    """
    if not S3_BUCKET:
        logger.warning("[S3] S3_BUCKET env var not set — skipping upload")
        return False

    client = _get_client()
    if not client:
        return False

    s3_key = f"saves/{slot}.json"
    try:
        client.upload_file(local_path, S3_BUCKET, s3_key)
        logger.info(f"[S3] Uploaded {local_path} → s3://{S3_BUCKET}/{s3_key}")
        return True
    except Exception as e:
        logger.error(f"[S3] Upload failed: {e}")
        return False


def upload_lore_file(local_path: str, filename: str) -> bool:
    """
    Upload an ingested lore file (PDF/TXT/MD) to S3_LORE_BUCKET.
    Returns True on success, False on any failure.
    """
    client = _get_client()
    if not client:
        return False
    s3_key = f"lore/{filename}"
    try:
        client.upload_file(local_path, S3_LORE_BUCKET, s3_key)
        logger.info(f"[S3] Uploaded lore → s3://{S3_LORE_BUCKET}/{s3_key}")
        return True
    except Exception as e:
        logger.error(f"[S3] Lore upload failed: {e}")
        return False


def download_save(slot: str, local_path: str) -> bool:
    """
    Download a save slot from S3 to a local path.

    Returns:
        True on success, False on any failure.
    """
    if not S3_BUCKET:
        return False

    client = _get_client()
    if not client:
        return False

    s3_key = f"saves/{slot}.json"
    try:
        client.download_file(S3_BUCKET, s3_key, local_path)
        logger.info(f"[S3] Downloaded s3://{S3_BUCKET}/{s3_key} → {local_path}")
        return True
    except Exception as e:
        logger.error(f"[S3] Download failed: {e}")
        return False
