FROM python:3.12-slim

WORKDIR /app

# Install system dependencies (git and libsndfile1 for local audio/TTS)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt setup_env.py ./
RUN python setup_env.py

COPY . .

EXPOSE 5000

CMD ["python", "app.py"]
