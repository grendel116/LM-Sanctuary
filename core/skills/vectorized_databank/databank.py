import os
import sqlite3
import json
import time
import requests
import numpy as np
from bs4 import BeautifulSoup

# Lazy-loaded embedding model to speed up server boot and reload times
_embedding_model = None

def get_embedding_model():
    global _embedding_model
    if _embedding_model is None:
        print(">>> Initializing SentenceTransformer model ('all-MiniLM-L6-v2')...")
        from sentence_transformers import SentenceTransformer
        # This will download the ~90MB model on first execution
        _embedding_model = SentenceTransformer('all-MiniLM-L6-v2')
        print(">>> SentenceTransformer model loaded successfully.")
    return _embedding_model


class DataBankManager:
    def __init__(self, db_dir=None):
        if db_dir is None:
            # Go up 3 levels to get from core/skills/vectorized_databank to core
            base_core = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            from utils.program import get_active_program
            active_program = get_active_program()
            db_dir = os.path.join(base_core, "programs", active_program)
        
        os.makedirs(db_dir, exist_ok=True)
        self.db_path = os.path.join(db_dir, "databank.db")
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            # Documents table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    timestamp REAL NOT NULL
                )
            """)
            # Chunks table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS chunks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    doc_id TEXT NOT NULL,
                    chunk_index INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    vector TEXT NOT NULL,
                    FOREIGN KEY (doc_id) REFERENCES documents (id) ON DELETE CASCADE
                )
            """)
            conn.commit()

    def clean_html(self, html_content: str) -> str:
        """Parses HTML and extracts clean readable text, removing boilerplate markup."""
        soup = BeautifulSoup(html_content, 'html.parser')
        
        # Remove script, style, header, footer, nav, and metadata elements
        for element in soup(["script", "style", "nav", "header", "footer", "form", "noscript", "aside"]):
            element.decompose()
            
        text = soup.get_text(separator=' ')
        
        # Consolidate whitespaces and empty lines
        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        clean_text = '\n'.join(chunk for chunk in chunks if chunk)
        
        return clean_text

    def scrape_url(self, url: str) -> str:
        """Fetches a webpage and scrapes clean plain text from it."""
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        res = requests.get(url, headers=headers, timeout=15)
        res.raise_for_status()
        return self.clean_html(res.text)

    def extract_pdf_text(self, file_path: str) -> str:
        """Tries to extract text from a PDF file using pypdf."""
        try:
            import pypdf
            reader = pypdf.PdfReader(file_path)
            text_parts = []
            for page in reader.pages:
                t = page.extract_text()
                if t:
                    text_parts.append(t)
            return "\n\n".join(text_parts)
        except ImportError:
            raise ImportError("The 'pypdf' package is required to parse PDF uploads. Please install it with 'pip install pypdf'.")

    def chunk_text(self, text: str, chunk_size: int = 500, overlap: int = 50) -> list:
        """Splits text into chunks of clean sentences/lines with rolling overlap."""
        if not text:
            return []
            
        # Standard recursive character splitter simulation
        paragraphs = text.split('\n\n')
        chunks = []
        current_chunk = []
        current_length = 0
        
        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
                
            # If a single paragraph is larger than the chunk size, split by lines or sentences
            if len(para) > chunk_size:
                sentences = para.replace('. ', '.\n').split('\n')
                for sent in sentences:
                    sent = sent.strip()
                    if not sent:
                        continue
                    if current_length + len(sent) > chunk_size and current_chunk:
                        chunks.append(" ".join(current_chunk))
                        # Keep last items for overlap
                        overlap_text = []
                        overlap_len = 0
                        for c in reversed(current_chunk):
                            if overlap_len + len(c) < overlap:
                                overlap_text.insert(0, c)
                                overlap_len += len(c)
                            else:
                                break
                        current_chunk = overlap_text
                        current_length = overlap_len
                    current_chunk.append(sent)
                    current_length += len(sent)
            else:
                if current_length + len(para) > chunk_size and current_chunk:
                    chunks.append(" ".join(current_chunk))
                    # Keep overlap
                    overlap_text = []
                    overlap_len = 0
                    for c in reversed(current_chunk):
                        if overlap_len + len(c) < overlap:
                            overlap_text.insert(0, c)
                            overlap_len += len(c)
                        else:
                            break
                    current_chunk = overlap_text
                    current_length = overlap_len
                current_chunk.append(para)
                current_length += len(para)
                
        if current_chunk:
            chunks.append(" ".join(current_chunk))
            
        return [c.strip() for c in chunks if c.strip()]

    def ingest_text(self, text: str, name: str, source_type: str, doc_id: str = None) -> str:
        """Chunks, embeds, and saves a text document to the local database."""
        if not doc_id:
            import uuid
            doc_id = str(uuid.uuid4())
            
        chunks = self.chunk_text(text)
        if not chunks:
            return doc_id
            
        # Generate embeddings in batch
        model = get_embedding_model()
        vectors = model.encode(chunks)
        
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            # Insert document reference
            cursor.execute(
                "INSERT INTO documents (id, name, source_type, size, timestamp) VALUES (?, ?, ?, ?, ?)",
                (doc_id, name, source_type, len(text), time.time())
            )
            # Insert chunk vectors
            for idx, (chunk_text, vector) in enumerate(zip(chunks, vectors)):
                vector_json = json.dumps(vector.tolist())
                cursor.execute(
                    "INSERT INTO chunks (doc_id, chunk_index, text, vector) VALUES (?, ?, ?, ?)",
                    (doc_id, idx, chunk_text, vector_json)
                )
            conn.commit()
            
        print(f"[Data Bank] Ingested document '{name}' ({len(chunks)} chunks).")
        return doc_id

    def ingest_file(self, file_path: str, original_filename: str) -> str:
        """Parses file type, extracts text, and ingests it."""
        ext = os.path.splitext(original_filename)[1].lower()
        
        if ext in ['.txt', '.md', '.py']:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
            return self.ingest_text(text, original_filename, "file")
            
        elif ext in ['.html', '.htm']:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                html = f.read()
            clean_text = self.clean_html(html)
            return self.ingest_text(clean_text, original_filename, "file")
            
        elif ext == '.pdf':
            clean_text = self.extract_pdf_text(file_path)
            return self.ingest_text(clean_text, original_filename, "file")
            
        else:
            raise ValueError(f"Unsupported file format: {ext}")

    def ingest_url(self, url: str) -> str:
        """Scrapes webpage URL and ingests it."""
        clean_text = self.scrape_url(url)
        # Clean URL to get a readable name
        name = url.split("://")[-1].strip("/")
        if len(name) > 60:
            name = name[:57] + "..."
        return self.ingest_text(clean_text, name, "url")

    def list_documents(self) -> list:
        """Lists all documents registered in the database."""
        with sqlite3.connect(self.db_path) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute("""
                SELECT d.id, d.name, d.source_type, d.size, d.timestamp, COUNT(c.id) as chunk_count
                FROM documents d
                LEFT JOIN chunks c ON d.id = c.doc_id
                GROUP BY d.id
                ORDER BY d.timestamp DESC
            """)
            return [dict(row) for row in cursor.fetchall()]

    def delete_document(self, doc_id: str) -> bool:
        """Removes a document and all its chunks from the database index."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM documents WHERE id = ?", (doc_id,))
            cursor.execute("DELETE FROM chunks WHERE doc_id = ?", (doc_id,))
            conn.commit()
            deleted = cursor.rowcount > 0
        return deleted

    def purge_all(self):
        """Purges the database, removing all files and chunks."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("DELETE FROM documents")
            cursor.execute("DELETE FROM chunks")
            conn.commit()
        print("[Data Bank] Purged all documents and vectors.")

    def query(self, query_text: str, top_k: int = 5, score_threshold: float = 0.25) -> str:
        """Queries the vector index and returns clean contextual matching chunks."""
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM chunks")
            if cursor.fetchone()[0] == 0:
                return ""
                
            cursor.execute("SELECT d.name, c.text, c.vector FROM chunks c JOIN documents d ON c.doc_id = d.id")
            rows = cursor.fetchall()
            
        if not rows:
            return ""
            
        # Get query embedding
        model = get_embedding_model()
        query_vector = model.encode(query_text)
        
        # Norm of query vector
        query_norm = np.linalg.norm(query_vector)
        if query_norm == 0:
            return ""
            
        results = []
        for doc_name, chunk_text, vector_json in rows:
            chunk_vector = np.array(json.loads(vector_json))
            chunk_norm = np.linalg.norm(chunk_vector)
            if chunk_norm == 0:
                continue
                
            # Compute cosine similarity
            similarity = np.dot(query_vector, chunk_vector) / (query_norm * chunk_norm)
            
            if similarity >= score_threshold:
                results.append((similarity, doc_name, chunk_text))
                
        # Sort by similarity score descending and pick top_k
        results.sort(key=lambda x: x[0], reverse=True)
        top_results = results[:top_k]
        
        if not top_results:
            return ""
            
        # Format the retrieved chunks for prompt injection
        formatted_context = []
        for idx, (score, doc_name, text) in enumerate(top_results):
            formatted_context.append(f"[{idx+1}] Source: {doc_name} (Similarity: {score:.2f})\n{text.strip()}")
            
        return "\n\n".join(formatted_context)
