import os
from google import genai
from dotenv import load_dotenv

# Robustly load .env file from the parent directory of this script
base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(base_dir, ".env"))

api_key = os.getenv("GEMINI_API_KEY")
client = genai.Client(api_key=api_key)
try:
    # Set page_size to 100 to retrieve all models in a single request
    for m in client.models.list(config={'page_size': 100}):
        name = m.name
        display_name = m.display_name
        supported_actions = m.supported_actions or []
        
        # Only show text generation chat models
        if "generateContent" not in supported_actions or not name.startswith("models/"):
            continue
            
        val = name.replace("models/", "")
        val_lower = val.lower()
        
        # Filter out tuning, embeddings, image/video, audio, or other utility models
        exclude_keywords = [
            "embed", "tuning", "bidi", "aqa", "imagen", "veo", "lyria", 
            "gemma", "deep-research", "robotics", "antigravity", "computer-use"
        ]
        if any(x in val_lower for x in exclude_keywords):
            continue
            
        # Filter out specific features, snapshots, or transient variants
        exclude_suffixes = [
            "-tts", "-audio", "-image", "-live", "-001", "-002", "-003", "-004", "-005"
        ]
        if any(x in val_lower for x in exclude_suffixes):
            continue
            
        print(f"Name: {name}, DisplayName: {display_name}")
except Exception as e:
    print("Exception occurred:", e)
