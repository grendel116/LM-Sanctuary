# Use a slim Python image
FROM python:3.11-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements (we will generate this)
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the source code
COPY . .

# Expose the Flask port
EXPOSE 5000

# Start the application
CMD ["python", "app.py"]
