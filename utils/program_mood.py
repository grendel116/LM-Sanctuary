"""
Utility module for extracting the companion's emotional state from generated text,
and mapping it strictly to dynamic heart indicator styles (glow, color, speed) in the UI.
"""
import os
import json
import re
import requests

base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def analyze_sentiment_with_llm(text: str) -> dict:
    """Classifies companion's message text into one of the core emotional states and intensity using the LLM."""
    if not text:
        return {
            "name": "calm",
            "color": "#85b9eb",
            "glow": "rgba(133, 185, 235, 0.9)",
            "speed": "2.0s",
            "intensity": 0.0
        }
        
    api_key = os.getenv("REMOTE_API_KEY")
    remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
    is_remote_configured = bool(
        api_key and api_key.strip() and api_key != "your_remote_api_key_here" and
        remote_cloud_url and remote_cloud_url.strip() and remote_cloud_url != "your_remote_cloud_url_here"
    )
    
    classification_json = None
    
    # Prompt instructing the LLM to classify the emotional state and intensity
    system_instruction = (
        "You are an emotional analysis subagent. Analyze the emotional state of the companion message. "
        "Classify it into one of these strict categories:\n"
        "- intimate (warm, affectionate, blushy, loving, or tender)\n"
        "- excited (playful, high-energy, cheerful, or giggly)\n"
        "- intense (sharp, focused, determined, or highly serious/grave)\n"
        "- sad (concerned, sorrowful, apologetic, or heavy-hearted)\n"
        "- calm (thoughtful, neutral, serene, or does not clearly fit the above)\n\n"
        "Also, determine the emotional intensity on a scale from 0.0 (very calm/mild) to 1.0 (extremely intense/high-energy).\n\n"
        "Respond ONLY with a valid JSON object matching this structure:\n"
        "{\n"
        '  "name": "intimate" | "excited" | "intense" | "sad" | "calm",\n'
        '  "intensity": float\n'
        "}"
    )
    
    if is_remote_configured:
        try:
            from variables import DEFAULT_REMOTE_MODEL
            payload = {
                "model": DEFAULT_REMOTE_MODEL,
                "messages": [
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": text}
                ],
                "temperature": 0.1,
                "response_format": {"type": "json_object"}
            }
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            }
            response = requests.post(remote_cloud_url, json=payload, headers=headers, timeout=10)
            if response.status_code == 200:
                res_data = response.json()
                content_str = res_data['choices'][0]['message']['content']
                match = re.search(r'\{.*\}', content_str, re.DOTALL)
                if match:
                    classification_json = json.loads(match.group(0))
                else:
                    classification_json = json.loads(content_str)
        except Exception as e:
            print(f"[ERROR] Remote sentiment classification failed: {e}")
            
    if not classification_json:
        # Fall back to local LM Studio server
        try:
            from variables import REMOTE_SERVER_URL, get_remote_server_headers
            payload = {
                "messages": [
                    {"role": "system", "content": system_instruction},
                    {"role": "user", "content": text}
                ],
                "temperature": 0.1,
                "response_format": {"type": "json_object"}
            }
            # Add target model if configured in env
            target_model = os.getenv("LOCAL_MODEL_NAME")
            if target_model:
                payload["model"] = target_model
                
            response = requests.post(
                REMOTE_SERVER_URL,
                json=payload,
                headers=get_remote_server_headers(),
                timeout=10
            )
            if response.status_code == 200:
                res_data = response.json()
                content_str = res_data['choices'][0]['message']['content']
                # Search for JSON if model wrapped it in conversational formatting
                match = re.search(r'\{.*\}', content_str, re.DOTALL)
                if match:
                    classification_json = json.loads(match.group(0))
                else:
                    classification_json = json.loads(content_str)
        except Exception as e:
            print(f"[ERROR] Local model sentiment classification failed: {e}")
            
    # Parse results and set default values if everything failed
    mood_name = "calm"
    intensity = 0.5
    if classification_json and isinstance(classification_json, dict):
        mood_name = str(classification_json.get("name", "calm")).lower().strip()
        try:
            intensity = float(classification_json.get("intensity", 0.5))
        except (ValueError, TypeError):
            intensity = 0.5
            
    intensity = max(0.0, min(1.0, intensity))
    if mood_name not in ["intimate", "excited", "intense", "sad", "calm"]:
        mood_name = "calm"
        
    mood_details = {
        "intimate": {"color": "#ff4a75", "glow": "rgba(255, 74, 117, 0.9)"},
        "excited": {"color": "#ff1493", "glow": "rgba(255, 20, 147, 0.9)"},
        "calm": {"color": "#85b9eb", "glow": "rgba(133, 185, 235, 0.9)"},
        "intense": {"color": "#ff7b00", "glow": "rgba(255, 123, 0, 0.9)"},
        "sad": {"color": "#5f7d95", "glow": "rgba(95, 125, 149, 0.9)"}
    }
    
    details = mood_details[mood_name].copy()
    details["name"] = mood_name
    details["intensity"] = intensity
    
    # Calculate heart pulse speed based on intensity (from 2.0s down to 0.6s)
    speed_seconds = 2.0 - (intensity * 1.4)
    details["speed"] = f"{speed_seconds:.2f}s"
    
    return details

def extract_and_strip_mood(text: str) -> tuple[str, dict]:
    """Classifies companion's message text using LLM-based sentiment analysis.
    No tags are expected or stripped from the text.
    
    Returns:
        A tuple of (original_text, mood_details_dict).
    """
    mood_details = analyze_sentiment_with_llm(text)
    return text, mood_details

def analyze_emotional_state(text: str) -> dict:
    """Wrapper returning only the mood dictionary."""
    return analyze_sentiment_with_llm(text)

