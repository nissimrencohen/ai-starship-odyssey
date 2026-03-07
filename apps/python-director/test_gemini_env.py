import os
import asyncio
from langchain_google_genai import ChatGoogleGenerativeAI
from dotenv import load_dotenv

async def test_gemini_env():
    load_dotenv()
    os.environ["GOOGLE_API_VERSION"] = "v1"
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("GOOGLE_API_KEY not found")
        return

    print("Testing gemini-1.5-flash with GOOGLE_API_VERSION=v1...")
    try:
        # Note: we don't pass api_version here, we let the env var handle it
        llm = ChatGoogleGenerativeAI(model="gemini-1.5-flash", google_api_key=api_key)
        res = await llm.ainvoke("Hello, say 'Test OK'")
        print(f"Success: {res.content}")
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    asyncio.run(test_gemini_env())
