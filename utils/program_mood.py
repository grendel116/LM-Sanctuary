"""
Utility module for extracting the companion's emotional state from generated text,
and mapping it strictly to dynamic heart indicator styles (glow, color, speed) in the UI.
"""
import os
import json
import re
import requests
from google import genai
from google.genai import types

_sentiment_cache = {}

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
        
    if text in _sentiment_cache:
        return _sentiment_cache[text]
        
    api_key = os.getenv("GEMINI_API_KEY")
    project_id = os.getenv("PROJECT_ID")
    is_gemini_configured = bool(
        api_key and api_key.strip() and api_key != "your_gemini_api_key_here" and
        project_id and project_id.strip() and project_id != "your_gcp_project_id_here"
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
    
    if is_gemini_configured:
        try:
            from variables import DEFAULT_GEMINI_MODEL
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model=DEFAULT_GEMINI_MODEL,
                contents=text,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    response_mime_type="application/json",
                    temperature=0.1
                )
            )
            classification_json = json.loads(response.text)
        except Exception as e:
            print(f"[ERROR] Gemini sentiment classification failed: {e}")
            
    if not classification_json:
        # Fall back to local LM Studio server
        try:
            from variables import LOCAL_SERVER_URL
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
                LOCAL_SERVER_URL,
                json=payload,
                headers={"Content-Type": "application/json"},
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
    
    _sentiment_cache[text] = details
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
