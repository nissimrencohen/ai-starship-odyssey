import os
import google.generativeai as genai
from dotenv import load_dotenv

def test_direct():
    load_dotenv()
    api_key = os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("GOOGLE_API_KEY not found")
        return

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel('gemini-pro-latest')
    print("Testing gemini-pro-latest direct...")
    try:
        response = model.generate_content("Hello, say 'Test OK'")
        print(f"Success: {response.text}")
    except Exception as e:
        print(f"Failed: {e}")

if __name__ == "__main__":
    test_direct()
