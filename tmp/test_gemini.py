import os
import google.generativeai as genai
from dotenv import load_dotenv

load_dotenv("c:/Project/.env")
api_key = os.getenv("GOOGLE_API_KEY")
if not api_key:
    print("NO GOOGLE_API_KEY FOUND")
else:
    genai.configure(api_key=api_key)
    print(f"Using API key: {api_key[:10]}...")
    try:
        models = genai.list_models()
        print("Available models:")
        for m in models:
            print(f"- {m.name}")
    except Exception as e:
        print(f"Error listing models: {e}")
