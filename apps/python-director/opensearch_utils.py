"""
OpenSearch Serverless utility — AWS RAG path.
Gracefully disabled when USE_AWS_RAG=false or credentials/endpoint are missing.
"""
import os
import logging

logger = logging.getLogger(__name__)

try:
    import boto3
    from opensearchpy import OpenSearch, RequestsHttpConnection, AWSV4SignerAuth
    _OPENSEARCH_AVAILABLE = True
except ImportError:
    _OPENSEARCH_AVAILABLE = False
    logger.info("[OpenSearch] boto3/opensearch-py not installed — AWS RAG disabled.")

OPENSEARCH_ENDPOINT = os.getenv("OPENSEARCH_ENDPOINT", "")
AWS_REGION          = os.getenv("AWS_REGION", "us-east-1")
INDEX_NAME          = os.getenv("OPENSEARCH_INDEX", "game-lore")

_client = None


def _get_client():
    global _client
    if _client is not None:
        return _client
    if not _OPENSEARCH_AVAILABLE or not OPENSEARCH_ENDPOINT:
        return None
    try:
        credentials = boto3.Session().get_credentials()
        auth = AWSV4SignerAuth(credentials, AWS_REGION, "aoss")
        _client = OpenSearch(
            hosts=[{"host": OPENSEARCH_ENDPOINT, "port": 443}],
            http_auth=auth,
            use_ssl=True,
            verify_certs=True,
            connection_class=RequestsHttpConnection,
            timeout=10,
        )
        return _client
    except Exception as e:
        logger.warning(f"[OpenSearch] Client init failed: {e}")
        return None


async def query_opensearch(query: str, k: int = 3) -> str:
    """
    Query OpenSearch for relevant lore chunks.
    Returns a formatted string or empty string if unavailable.
    kNN query will use Bedrock Titan embeddings once the SQS worker is wired in.
    """
    client = _get_client()
    if client is None:
        return ""
    try:
        response = client.search(
            index=INDEX_NAME,
            body={"query": {"match": {"text": query}}, "size": k},
        )
        hits = response.get("hits", {}).get("hits", [])
        chunks = [h["_source"].get("text", "") for h in hits]
        return "\n---\n".join(chunks)
    except Exception as e:
        logger.warning(f"[OpenSearch] Query failed: {e}")
        return ""


def index_document(doc_id: str, text: str, embedding: list, metadata: dict = None) -> bool:
    """Index a document chunk with an embedding vector. Used by the SQS worker."""
    client = _get_client()
    if client is None:
        return False
    try:
        body = {"text": text, "embedding": embedding, **(metadata or {})}
        client.index(index=INDEX_NAME, id=doc_id, body=body)
        return True
    except Exception as e:
        logger.warning(f"[OpenSearch] Index failed for {doc_id}: {e}")
        return False
