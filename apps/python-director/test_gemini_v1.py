import os
import asyncio
from langchain_google_genai import ChatGoogleGenerativeAI
from dotenv import load_dotenv

async def test_gemini():
    load_dotenv()
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("GOOGLE_API_KEY not found")
        return

    print("Testing gemini-2.0-flash with default settings...")
    try:
        llm = ChatGoogleGenerativeAI(model="gemini-2.0-flash", google_api_key=api_key)
        res = await llm.ainvoke("Hello, say 'Test OK'")
        print(f"Success: {res.content}")
    except Exception as e:
        print(f"Default failed: {e}")

    print("\nTesting gemini-2.0-flash with api_version='v1'...")
    try:
        llm = ChatGoogleGenerativeAI(model="gemini-2.0-flash", google_api_key=api_key, api_version="v1")
        res = await llm.ainvoke("Hello, say 'Test OK'")
        print(f"Success with v1: {res.content}")
    except Exception as e:
        print(f"v1 failed: {e}")

if __name__ == "__main__":
    asyncio.run(test_gemini())
