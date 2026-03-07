import os
import httpx
from dotenv import load_dotenv

async def test_elevenlabs():
    load_dotenv()
    api_key = os.getenv("ELEVENLABS_API_KEY")
    if api_key.startswith("sk_"):
        api_key = api_key[3:]
    print(f"Testing key (no prefix): {api_key[:10]}... (Total length: {len(api_key)})")
    
    url = "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json"
    }
    payload = {
        "text": "Hello world",
        "model_id": "eleven_turbo_v2_5"
    }
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(url, headers=headers, json=payload)
            if response.status_code == 200:
                print("Success! TTS worked.")
            else:
                print(f"Failed with status {response.status_code}")
                print(response.text)
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    import asyncio
    asyncio.run(test_elevenlabs())
