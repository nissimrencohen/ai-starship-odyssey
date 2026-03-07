import os
import sys
import asyncio
import httpx
from dotenv import load_dotenv

# Absolute path to .env in the project root
dotenv_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '.env'))
print(f"Loading .env from: {dotenv_path}")
load_dotenv(dotenv_path, override=True)

async def test_gemini():
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return "FAILED (Missing GOOGLE_API_KEY)"
    
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={api_key}"
    payload = {
        "contents": [{"parts": [{"text": "Reply with 'ping'"}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 10}
    }
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(url, json=payload, timeout=10.0)
            if r.status_code == 200:
                return "READY"
            else:
                return f"FAILED (HTTP {r.status_code})"
    except Exception as e:
        return f"FAILED ({e})"

async def test_groq():
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        return "FAILED (Missing GROQ_API_KEY)"
    
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
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(url, headers=headers, json=payload, timeout=10.0)
            if r.status_code == 200:
                return "READY"
            else:
                return f"FAILED (HTTP {r.status_code})"
    except Exception as e:
        return f"FAILED ({e})"



async def test_github():
    api_key = os.getenv("GITHUB_API_KEY")
    if not api_key:
        return "FAILED (Missing GITHUB_API_KEY)"
    
    # GitHub Models endpoint
    url = "https://models.inference.ai.azure.com/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "gpt-4o", # Default testing model
        "messages": [{"role": "user", "content": "Reply with 'ping'"}],
        "max_tokens": 10
    }
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(url, headers=headers, json=payload, timeout=10.0)
            if r.status_code == 200:
                return "READY"
            else:
                return f"FAILED (HTTP {r.status_code})"
    except Exception as e:
        return f"FAILED ({e})"

async def test_elevenlabs():
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if not api_key:
        return "FAILED (Missing ELEVENLABS_API_KEY)"
    
    url = "https://api.elevenlabs.io/v1/user/subscription"
    headers = {"xi-api-key": api_key}
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(url, headers=headers, timeout=10.0)
            if r.status_code == 200:
                data = r.json()
                left = data.get("character_count", 0)
                limit = data.get("character_limit", 0)
                if left >= limit:
                    return f"FAILED (Quota Exceeded: {left}/{limit})"
                return f"READY (Quota: {left}/{limit})"
            elif r.status_code == 401:
                return "FAILED (401 Unauthorized)"
            else:
                return f"FAILED (HTTP {r.status_code})"
    except Exception as e:
        return f"FAILED ({e})"

async def main():
    print("="*50)
    print("🚀 API READINESS TEST (Ver 3.0)")
    print("="*50)
    
    print("1. Testing Gemini (Google)....... ", end="", flush=True)
    print(await test_gemini())
    
    print("2. Testing Groq (Llama 3.3)...... ", end="", flush=True)
    print(await test_groq())
    
    print("3. Testing GitHub (GPT-4o)....... ", end="", flush=True)
    print(await test_github())
    
    print("4. Testing ElevenLabs (TTS)...... ", end="", flush=True)
    print(await test_elevenlabs())

    print("="*50)

if __name__ == "__main__":
    asyncio.run(main())
