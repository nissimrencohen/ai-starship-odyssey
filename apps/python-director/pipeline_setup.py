import asyncio
import os
import httpx
import logging
from dotenv import load_dotenv

# Attempt to load .env from common locations
possible_paths = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '.env'),
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env'),
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), '.env'),
]
for path in possible_paths:
    if os.path.exists(path):
        load_dotenv(path, override=True)
        break


logger = logging.getLogger(__name__)

AI_MODEL_MODE = os.getenv("AI_MODEL_MODE", "")

# Hugging Face Inference API Configuration
HF_TOKEN = os.getenv("HF_TOKEN")
# Using SDXL Base via the new router endpoint to avoid 410 errors
HF_API_URL = "https://router.huggingface.co/hf-inference/models/stabilityai/stable-diffusion-xl-base-1.0"

# Local GPU pipeline (set by _preload_sdxl, called from main.py startup)
_local_sdxl_pipeline = None


def _preload_sdxl():
    """Preload SDXL-Turbo on CUDA in FP16. Called from main.py startup executor."""
    global _local_sdxl_pipeline
    import torch
    from diffusers import AutoPipelineForText2Image
    logger.info("[IMG] Preloading SDXL-Turbo on CUDA (fp16)...")
    pipe = AutoPipelineForText2Image.from_pretrained(
        "stabilityai/sdxl-turbo",
        torch_dtype=torch.float16,
        variant="fp16",
    ).to("cuda")
    try:
        pipe.enable_xformers_memory_efficient_attention()
    except Exception:
        pass  # xformers optional
    _local_sdxl_pipeline = pipe
    logger.info("[IMG] SDXL-Turbo ready.")


async def generate_texture(prompt: str, output_path: str):
    """
    Generates a texture. Uses SDXL-Turbo locally when AI_MODEL_MODE=LOCAL_GPU,
    otherwise falls back to the Hugging Face Inference API.
    """
    prompt_lower = prompt.lower()
    is_ring = "ring" in prompt_lower or "asteroid" in prompt_lower

    if is_ring:
        augmented_prompt = f"{prompt}, equirectangular projection, flat map, asteroid textures, varying space rock surface, multi-frame surface material"
        negative_prompt = "ring shape, circular border, void, black background, stars, text"
    else:
        augmented_prompt = f"{prompt}, seamless texture, equirectangular projection, flat map, full frame material, overhead view"
        negative_prompt = ""

    # ── LOCAL_GPU path: SDXL-Turbo ────────────────────────────────────────────
    if AI_MODEL_MODE == "LOCAL_GPU" and _local_sdxl_pipeline is not None:
        logger.info(f"[IMG] LOCAL_GPU: Generating texture with SDXL-Turbo for: {augmented_prompt}")
        loop = asyncio.get_event_loop()

        def _run():
            image = _local_sdxl_pipeline(
                prompt=augmented_prompt,
                negative_prompt=negative_prompt or None,
                num_inference_steps=4,
                guidance_scale=0.0,
            ).images[0]
            dir_name = os.path.dirname(output_path)
            if dir_name:
                os.makedirs(dir_name, exist_ok=True)
            image.save(output_path)
            return output_path

        return await loop.run_in_executor(None, _run)

    # ── Cloud fallback: HF Inference API ─────────────────────────────────────
    if not HF_TOKEN:
        logger.error("HF_TOKEN is missing in environment! Cannot generate texture.")
        raise ValueError("HF_TOKEN missing")

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
