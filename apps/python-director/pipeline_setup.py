import os
import httpx
import logging
from dotenv import load_dotenv

# Load .env from project root
dotenv_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), '.env')
load_dotenv(dotenv_path, override=True)

logger = logging.getLogger(__name__)

# Hugging Face Inference API Configuration
HF_TOKEN = os.getenv("HF_TOKEN")
# Using SDXL Base via the new router endpoint to avoid 410 errors
HF_API_URL = "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0"

async def generate_texture(prompt: str, output_path: str):
    """
    Generates a texture using the Hugging Face Inference API via raw HTTPX.
    Bypasses the huggingface_hub library to avoid StopIteration errors.
    """
    if not HF_TOKEN:
        logger.error("HF_TOKEN is missing in environment! Cannot generate texture.")
        raise ValueError("HF_TOKEN missing")

    prompt_lower = prompt.lower()
    is_ring = "ring" in prompt_lower or "asteroid" in prompt_lower

    if is_ring:
        augmented_prompt = f"{prompt}, equirectangular projection, flat map, asteroid textures, varying space rock surface, multi-frame surface material"
        negative_prompt = "ring shape, circular border, void, black background, stars, text"
    else:
        augmented_prompt = f"{prompt}, seamless texture, equirectangular projection, flat map, full frame material, overhead view"
        negative_prompt = ""
    
    headers = {"Authorization": f"Bearer {HF_TOKEN}"}
    payload = {
        "inputs": augmented_prompt,
        "parameters": {
            "negative_prompt": negative_prompt
        }
    }

    logger.info(f"[HF-Inference Raw] Requesting texture for prompt: {augmented_prompt}")

    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            response = await client.post(HF_API_URL, headers=headers, json=payload)
            
            if response.status_code == 200:
                # API returns raw image bytes
                image_bytes = response.content
                
                # Ensure directory exists
                dir_name = os.path.dirname(output_path)
                if dir_name:
                    os.makedirs(dir_name, exist_ok=True)
                
                with open(output_path, "wb") as f:
                    f.write(image_bytes)
                
                logger.info(f"Successfully generated and saved raw HF texture to {output_path}")
                return output_path
            else:
                logger.error(f"HF API Error: {response.status_code} - {response.text}")
                raise Exception(f"Hugging Face API failed with status {response.status_code}: {response.text}")
                
        except Exception as e:
            logger.error(f"Failed to call HF Inference API: {e}")
            raise e
