import os
import requests
import base64
import hashlib
from dotenv import load_dotenv

# Ensure environment is loaded
load_dotenv()

class BaseSpeechProvider:
    def generate(self, text: str, output_path: str) -> bool:
        raise NotImplementedError

class LocalSpeechProvider(BaseSpeechProvider):
    def __init__(self):
        self.kokoro = None
        self.voice_name = os.getenv("TTS_VOICE", "af_heart")
        
    def _lazy_init(self):
        if self.kokoro is not None:
            return
        try:
            from kokoro_onnx import Kokoro
            base_dir = os.path.dirname(os.path.abspath(__file__))
            model_path = os.path.join(base_dir, "speech_model", "kokoro-v1.0.onnx")
            voices_path = os.path.join(base_dir, "speech_model", "voices-v1.0.bin")
            
            if not os.path.exists(model_path) or not os.path.exists(voices_path):
                print("Local TTS model files missing. Initiating automatic download...")
                os.makedirs(os.path.join(base_dir, "speech_model"), exist_ok=True)
                
                def download_file(url, dest):
                    print(f"Downloading {url} to {dest}...")
                    r = requests.get(url, headers={'User-Agent': 'Mozilla/5.0'}, stream=True)
                    r.raise_for_status()
                    with open(dest, 'wb') as f:
                        for chunk in r.iter_content(chunk_size=8192):
                            if chunk:
                                f.write(chunk)
                    print(f"Download complete: {dest}")
                
                if not os.path.exists(model_path):
                    download_file(
                        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
                        model_path
                    )
                if not os.path.exists(voices_path):
                    download_file(
                        "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin",
                        voices_path
                    )
                
            self.kokoro = Kokoro(model_path, voices_path)
            print("Local Kokoro TTS initialized successfully.")
        except Exception as e:
            print(f"Error initializing Local Kokoro TTS: {e}")
            raise e

    def generate(self, text: str, output_path: str) -> bool:
        self._lazy_init()
        import soundfile as sf
        try:
            # Dynamically read TTS voice from project settings
            from utils.program import get_tts_voice
            active_voice = get_tts_voice()
            
            # Generate speech samples
            samples, sample_rate = self.kokoro.create(
                text, 
                voice=active_voice,
                speed=1.0, 
                lang="en-us"
            )
            sf.write(output_path, samples, sample_rate)
            return True
        except Exception as e:
            print(f"Local Kokoro TTS generation error: {e}")
            return False

class ElevenLabsSpeechProvider(BaseSpeechProvider):
    def __init__(self):
        self.api_key = os.getenv("ELEVENLABS_API_KEY")
        self.voice_id = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")  # Default female voice
        
    def generate(self, text: str, output_path: str) -> bool:
        if not self.api_key:
            print("ElevenLabs API Key is missing from .env configuration.")
            return False
            
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}"
        headers = {
            "xi-api-key": self.api_key,
            "Content-Type": "application/json"
        }
        data = {
            "text": text,
            "model_id": "eleven_monolingual_v1",
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75
            }
        }
        try:
            response = requests.post(url, json=data, headers=headers)
            if response.status_code != 200:
                print(f"ElevenLabs TTS error: Status {response.status_code} - {response.text}")
                return False
                
            with open(output_path, 'wb') as f:
                f.write(response.content)
            return True
        except Exception as e:
            print(f"ElevenLabs TTS exception: {e}")
            return False

class GoogleSpeechProvider(BaseSpeechProvider):
    def __init__(self):
        self.voice_name = os.getenv("GOOGLE_TTS_VOICE_NAME", "en-US-Neural2-F")
        
    def _get_access_token(self):
        try:
            import google.auth
            import google.auth.transport.requests
            credentials, project = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
            req = google.auth.transport.requests.Request()
            credentials.refresh(req)
            return credentials.token
        except Exception as e:
            print(f"Google Auth failed for TTS: {e}")
            return None

    def generate(self, text: str, output_path: str) -> bool:
        token = self._get_access_token()
        if not token:
            print("Google Cloud credentials not found or failed to authorize.")
            return False
            
        url = "https://texttospeech.googleapis.com/v1/text:synthesize"
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json"
        }
        payload = {
            "input": {"text": text},
            "voice": {
                "languageCode": "en-US",
                "name": self.voice_name
            },
            "audioConfig": {
                "audioEncoding": "MP3"
            }
        }
        try:
            response = requests.post(url, json=payload, headers=headers)
            if response.status_code != 200:
                print(f"Google Cloud TTS error: Status {response.status_code} - {response.text}")
                return False
                
            resp_data = response.json()
            audio_content = base64.b64decode(resp_data["audioContent"])
            with open(output_path, 'wb') as f:
                f.write(audio_content)
            return True
        except Exception as e:
            print(f"Google Cloud TTS exception: {e}")
            return False

class SpeechManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(SpeechManager, cls).__new__(cls)
            cls._instance.provider_name = os.getenv("TTS_PROVIDER", "local").lower()
            cls._instance.cache_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "speech_cache"
            )
            os.makedirs(cls._instance.cache_dir, exist_ok=True)
            
            # Select provider
            if cls._instance.provider_name == "elevenlabs":
                cls._instance.provider = ElevenLabsSpeechProvider()
            elif cls._instance.provider_name == "google":
                cls._instance.provider = GoogleSpeechProvider()
            else:
                cls._instance.provider = LocalSpeechProvider()
                
            print(f"SpeechManager active provider: {cls._instance.provider_name}")
        return cls._instance

    def get_speech_file(self, text: str, message_id: str) -> str:
        """
        Synthesizes speech and returns the relative URL to the cached audio file.
        Returns None or empty string on failure.
        """
        # Strip simple Markdown markers (asterisks, underscores) for clean reading
        clean_text = text.replace('*', '').replace('_', '').replace('`', '').strip()
        if not clean_text:
            return ""
            
        # Determine extension based on provider
        ext = "wav" if self.provider_name == "local" else "mp3"
        filename = f"{message_id}.{ext}"
        full_path = os.path.join(self.cache_dir, filename)
        
        # If cache exists, return URL directly
        if os.path.exists(full_path):
            return f"/speech_cache/{filename}"
            
        # Synthesize audio
        print(f"Synthesizing speech via {self.provider_name} for message {message_id}...")
        success = self.provider.generate(clean_text, full_path)
        if success:
            return f"/speech_cache/{filename}"
        return ""
