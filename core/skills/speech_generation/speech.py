import os
import re
import requests
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
            from runners.program import get_tts_voice
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

class SpeechManager:
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(SpeechManager, cls).__new__(cls)
            cls._instance.provider_name = "local"
            cls._instance.cache_dir = os.path.join(
                os.path.dirname(os.path.abspath(__file__)),
                "speech_cache"
            )
            os.makedirs(cls._instance.cache_dir, exist_ok=True)
            cls._instance.provider = LocalSpeechProvider()
            print(f"SpeechManager active provider: {cls._instance.provider_name}")
        return cls._instance

    def get_speech_file(self, text: str, message_id: str) -> str:
        """
        Synthesizes speech and returns the relative URL to the cached audio file.
        Returns None or empty string on failure.
        """
        # Strip simple Markdown markers (asterisks, underscores) for clean reading
        clean_text = text.replace('*', '').replace('_', '').replace('`', '')
        # Strip HTML comment blocks
        clean_text = re.sub(r'<!--.*?-->', '', clean_text, flags=re.DOTALL).strip()
        if not clean_text:
            return ""
            
        filename = f"{message_id}.wav"
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
