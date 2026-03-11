"""
Amazon Bedrock utility — Titan embeddings + Claude 3 generation.
Gracefully disabled when USE_AWS_RAG=false or credentials are missing.
"""
import os
import json
import logging

logger = logging.getLogger(__name__)

try:
    import boto3
    _BOTO3_AVAILABLE = True
except ImportError:
    _BOTO3_AVAILABLE = False
    logger.info("[Bedrock] boto3 not installed — Bedrock path disabled.")

AWS_REGION      = os.getenv("AWS_REGION", "us-east-1")
TITAN_MODEL_ID  = "amazon.titan-embed-text-v2:0"
CLAUDE_MODEL_ID = "anthropic.claude-3-sonnet-20240229-v1:0"

_bedrock_client = None


def _get_client():
    global _bedrock_client
    if _bedrock_client is not None:
        return _bedrock_client
    if not _BOTO3_AVAILABLE:
        return None
    try:
        _bedrock_client = boto3.client("bedrock-runtime", region_name=AWS_REGION)
        return _bedrock_client
    except Exception as e:
        logger.warning(f"[Bedrock] Client init failed: {e}")
        return None


def generate_titan_embedding(text: str) -> list:
    """
    Generate an embedding via Amazon Titan Embed Text v2 (1024-dim).
    Returns list of floats or empty list on failure.
    """
    client = _get_client()
    if client is None:
        return []
    try:
        body = json.dumps({"inputText": text})
        response = client.invoke_model(
            modelId=TITAN_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=body,
        )
        result = json.loads(response["body"].read())
        return result.get("embedding", [])
    except Exception as e:
        logger.warning(f"[Bedrock] Titan embedding failed: {e}")
        return []


async def generate_claude_response(system_prompt: str, user_message: str) -> str:
    """
    Generate a grounded RAG response via Bedrock Claude 3 Sonnet.
    Runs in a thread executor to avoid blocking the event loop.
    Returns empty string if Bedrock is unavailable.
    """
    client = _get_client()
    if client is None:
        return ""
    try:
        import asyncio
        loop = asyncio.get_event_loop()

        def _invoke():
            body = json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 512,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_message}],
            })
            response = client.invoke_model(
                modelId=CLAUDE_MODEL_ID,
                contentType="application/json",
                accept="application/json",
                body=body,
            )
            result = json.loads(response["body"].read())
            return result["content"][0]["text"]

        return await loop.run_in_executor(None, _invoke)
    except Exception as e:
        logger.warning(f"[Bedrock] Claude generation failed: {e}")
        return ""
