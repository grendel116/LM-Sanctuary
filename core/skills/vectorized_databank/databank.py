import os
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
        self.db_path = os.path.join(db_dir, "databank.json")
        self.memories_path = os.path.join(db_dir, "memories.json")
        
        # Migration from legacy journal.json to memories.json
        legacy_journal_path = os.path.join(db_dir, "journal.json")
        if os.path.exists(legacy_journal_path) and not os.path.exists(self.memories_path):
            try:
                os.rename(legacy_journal_path, self.memories_path)
                print(f"[DATABANK MIGRATION] Renamed legacy {legacy_journal_path} to {self.memories_path}", flush=True)
            except Exception as e:
                print(f"[DATABANK MIGRATION ERROR] Failed to rename legacy journal: {e}", flush=True)
                
        self._init_db()

    def _init_db(self):
        if not os.path.exists(self.db_path):
            self._save_data(self.db_path, {"documents": [], "chunks": []})
        if not os.path.exists(self.memories_path):
            self._save_data(self.memories_path, {"documents": [], "chunks": []})

    def _load_data(self, path):
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception as e:
            print(f"Error loading JSON file at {path}: {e}")
        return {"documents": [], "chunks": []}

    def _save_data(self, path, data):
        try:
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Error saving JSON file to {path}: {e}")

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
        """Chunks, embeds, and saves a text document to the local JSON files."""
        if not doc_id:
            import uuid
            doc_id = str(uuid.uuid4())
            
        chunks = self.chunk_text(text)
        if not chunks:
            return doc_id
            
        # Generate embeddings in batch
        model = get_embedding_model()
        vectors = model.encode(chunks)
        
        # Decide which database file to use
        is_chat_history = (source_type == 'chat_history')
        path = self.memories_path if is_chat_history else self.db_path
        
        data = self._load_data(path)
        
        # Insert document reference
        data["documents"].append({
            "id": doc_id,
            "name": name,
            "source_type": source_type,
            "size": len(text),
            "timestamp": time.time()
        })
        
        # Insert chunk vectors
        for idx, (chunk_text, vector) in enumerate(zip(chunks, vectors)):
            data["chunks"].append({
                "doc_id": doc_id,
                "chunk_index": idx,
                "text": chunk_text,
                "vector": vector.tolist()
            })
            
        self._save_data(path, data)
        print(f"[Data Bank] Ingested document '{name}' ({len(chunks)} chunks) into {'journal' if is_chat_history else 'databank'}.")
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
        """Lists all documents registered in databank.json (excluding chat history memory)."""
        data = self._load_data(self.db_path)
        
        chunk_counts = {}
        for chunk in data["chunks"]:
            doc_id = chunk["doc_id"]
            chunk_counts[doc_id] = chunk_counts.get(doc_id, 0) + 1
            
        results = []
        for doc in data["documents"]:
            if doc["source_type"] != 'chat_history':
                doc_copy = doc.copy()
                doc_copy["chunk_count"] = chunk_counts.get(doc["id"], 0)
                results.append(doc_copy)
                
        results.sort(key=lambda x: x["timestamp"], reverse=True)
        return results

    def delete_document(self, doc_id: str) -> bool:
        """Removes a document and all its chunks from the databank.json file."""
        data = self._load_data(self.db_path)
        
        original_doc_count = len(data["documents"])
        
        data["documents"] = [d for d in data["documents"] if d["id"] != doc_id]
        data["chunks"] = [c for c in data["chunks"] if c["doc_id"] != doc_id]
        
        self._save_data(self.db_path, data)
        return len(data["documents"]) < original_doc_count

    def delete_chat_history(self, session_id: str):
        """Deletes all chat history archives associated with the session from memories.json."""
        data = self._load_data(self.memories_path)
        
        prefix = f"chat_history_archive_{session_id}_"
        doc_ids_to_delete = [
            d["id"] for d in data["documents"] 
            if d["source_type"] == 'chat_history' and d["name"].startswith(prefix)
        ]
        
        if doc_ids_to_delete:
            doc_ids_set = set(doc_ids_to_delete)
            data["documents"] = [d for d in data["documents"] if d["id"] not in doc_ids_set]
            data["chunks"] = [c for c in data["chunks"] if c["doc_id"] not in doc_ids_set]
            self._save_data(self.memories_path, data)
            
        print(f"[Data Bank] Deleted {len(doc_ids_to_delete)} chat history archives for session '{session_id}' in memories.")

    def get_prior_chat_histories(self, session_id: str, limit: int = 2) -> list:
        """Retrieves prior chat histories from memories.json."""
        data = self._load_data(self.memories_path)
        
        prefix = f"chat_history_archive_{session_id}_"
        chat_docs = [
            d for d in data["documents"]
            if d["source_type"] == 'chat_history' and d["name"].startswith(prefix)
        ]
        
        chat_docs.sort(key=lambda x: x["timestamp"], reverse=True)
        target_docs = chat_docs[:limit]
        
        archives = []
        for doc in target_docs:
            doc_id = doc["id"]
            doc_chunks = [c for c in data["chunks"] if c["doc_id"] == doc_id]
            doc_chunks.sort(key=lambda x: x["chunk_index"])
            
            archives.append({
                "name": doc["name"],
                "text": "\n".join(c["text"] for c in doc_chunks)
            })
            
        return archives

    def prune_chat_histories(self, session_id: str, keep_limit: int = 3):
        """Prunes older chat history archives from memories.json."""
        data = self._load_data(self.memories_path)
        
        prefix = f"chat_history_archive_{session_id}_"
        chat_docs = [
            d for d in data["documents"]
            if d["source_type"] == 'chat_history' and d["name"].startswith(prefix)
        ]
        
        chat_docs.sort(key=lambda x: x["timestamp"], reverse=True)
        
        if len(chat_docs) > keep_limit:
            to_delete_docs = chat_docs[keep_limit:]
            to_delete_ids = set(d["id"] for d in to_delete_docs)
            
            data["documents"] = [d for d in data["documents"] if d["id"] not in to_delete_ids]
            data["chunks"] = [c for c in data["chunks"] if c["doc_id"] not in to_delete_ids]
            
            self._save_data(self.memories_path, data)
            print(f"[Data Bank] Pruned {len(to_delete_ids)} older chat history archives for session '{session_id}' in memories.")

    def purge_all(self):
        """Purges both databank.json and memories.json."""
        self._save_data(self.db_path, {"documents": [], "chunks": []})
        self._save_data(self.memories_path, {"documents": [], "chunks": []})
        print("[Data Bank] Purged all documents and vectors from databank and memories.")

    def query(self, query_text: str, top_k: int = 5, score_threshold: float = 0.25, exclude_source_type: str = None, include_source_type: str = None) -> str:
        """Queries the respective JSON vector index and returns clean contextual matching chunks."""
        # Query memories.json for chat history, otherwise query databank.json
        is_chat_history = (include_source_type == 'chat_history')
        path = self.memories_path if is_chat_history else self.db_path
        
        data = self._load_data(path)
        
        if not data["chunks"]:
            return ""
            
        docs_map = {d["id"]: d for d in data["documents"]}
        
        filtered_chunks = []
        for chunk in data["chunks"]:
            doc = docs_map.get(chunk["doc_id"])
            if not doc:
                continue
            if exclude_source_type and doc["source_type"] == exclude_source_type:
                continue
            if include_source_type and doc["source_type"] != include_source_type:
                continue
            filtered_chunks.append((doc["name"], chunk["text"], chunk["vector"]))
            
        if not filtered_chunks:
            return ""
            
        # Get query embedding
        model = get_embedding_model()
        query_vector = model.encode(query_text)
        
        # Norm of query vector
        query_norm = np.linalg.norm(query_vector)
        if query_norm == 0:
            return ""
            
        results = []
        for doc_name, chunk_text, vector in filtered_chunks:
            chunk_vector = np.array(vector)
            chunk_norm = np.linalg.norm(chunk_vector)
            if chunk_norm == 0:
                continue
                
            # Compute cosine similarity
            similarity = np.dot(query_vector, chunk_vector) / (query_norm * chunk_norm)
            
            if similarity >= score_threshold:
                results.append((similarity, doc_name, chunk_text))
                
        results.sort(key=lambda x: x[0], reverse=True)
        top_results = results[:top_k]
        
        if not top_results:
            return ""
            
        formatted_context = []
        if is_chat_history:
            for score, doc_name, text in top_results:
                formatted_context.append(text.strip())
            return "\n\n---\n\n".join(formatted_context)
        else:
            for idx, (score, doc_name, text) in enumerate(top_results):
                formatted_context.append(f"[{idx+1}] Source: {doc_name} (Similarity: {score:.2f})\n{text.strip()}")
            return "\n\n".join(formatted_context)
