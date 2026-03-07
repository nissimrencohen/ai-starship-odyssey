import os
import httpx
from dotenv import load_dotenv

# Absolute path to .env in the project root
dotenv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '.env'))
print(f"Loading .env from: {dotenv_path}")
load_dotenv(dotenv_path)

async def debug_groq():
    api_key = os.getenv("GROQ_API_KEY")
    print(f"API Key starts with: {api_key[:10]}... Length: {len(api_key) if api_key else 0}")
    
    url = "https://api.groq.com/openai/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": [{"role": "user", "content": "Reply with 'ping'"}],
        "max_tokens": 10
    }
    
    async with httpx.AsyncClient() as client:
        try:
            r = await client.post(url, headers=headers, json=payload, timeout=10.0)
            print(f"Status: {r.status_code}")
            print(f"Response Body: {r.text}")
        except Exception as e:
            print(f"Exception: {e}")

if __name__ == "__main__":
    import asyncio
    asyncio.run(debug_groq())
