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
            from runners.program import get_active_program
            active_program = get_active_program()
            db_dir = os.path.join(base_core, "programs", active_program)
        
        os.makedirs(db_dir, exist_ok=True)
        self.db_path = os.path.join(db_dir, "databank.json")
                
        self._init_db()

    def _init_db(self):
        if not os.path.exists(self.db_path):
            self._save_data(self.db_path, {"documents": [], "chunks": []})

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
        
        for element in soup(["script", "style", "nav", "header", "footer", "form", "noscript", "aside"]):
            element.decompose()
            
        text = soup.get_text(separator=' ')
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
            
        paragraphs = text.split('\n\n')
        chunks = []
        current_chunk = []
        current_length = 0
        
        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
                
            if len(para) > chunk_size:
                sentences = para.replace('. ', '.\n').split('\n')
                for sent in sentences:
                    sent = sent.strip()
                    if not sent:
                        continue
                    if current_length + len(sent) > chunk_size and current_chunk:
                        chunks.append(" ".join(current_chunk))
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

    def ingest_text(self, text: str, name: str, source_type: str = "file", doc_id: str = None) -> str:
        """Chunks, embeds, and saves a text document to databank.json."""
        if not doc_id:
            import uuid
            doc_id = str(uuid.uuid4())
            
        chunks = self.chunk_text(text)
        if not chunks:
            return doc_id
            
        model = get_embedding_model()
        vectors = model.encode(chunks)
        
        data = self._load_data(self.db_path)
        
        data["documents"].append({
            "id": doc_id,
            "name": name,
            "source_type": source_type,
            "size": len(text),
            "timestamp": time.time()
        })
        
        for idx, (chunk_text, vector) in enumerate(zip(chunks, vectors)):
            data["chunks"].append({
                "doc_id": doc_id,
                "chunk_index": idx,
                "text": chunk_text,
                "vector": vector.tolist()
            })
            
        self._save_data(self.db_path, data)
        print(f"[Data Bank] Ingested document '{name}' ({len(chunks)} chunks) into databank.")
        return doc_id

    def ingest_file(self, file_path: str, original_filename: str) -> str:
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
        clean_text = self.scrape_url(url)
        name = url.split("://")[-1].strip("/")
        if len(name) > 60:
            name = name[:57] + "..."
        return self.ingest_text(clean_text, name, "url")

    def list_documents(self) -> list:
        """Lists all documents registered in databank.json."""
        data = self._load_data(self.db_path)
        
        chunk_counts = {}
        for chunk in data["chunks"]:
            doc_id = chunk["doc_id"]
            chunk_counts[doc_id] = chunk_counts.get(doc_id, 0) + 1
            
        results = []
        for doc in data["documents"]:
            doc_copy = doc.copy()
            doc_copy["chunk_count"] = chunk_counts.get(doc["id"], 0)
            results.append(doc_copy)
                
        results.sort(key=lambda x: x["timestamp"], reverse=True)
        return results

    def delete_document(self, doc_id: str) -> bool:
        """Removes a document and all its chunks from databank.json."""
        data = self._load_data(self.db_path)
        original_doc_count = len(data["documents"])
        
        data["documents"] = [d for d in data["documents"] if d["id"] != doc_id]
        data["chunks"] = [c for c in data["chunks"] if c["doc_id"] != doc_id]
        
        self._save_data(self.db_path, data)
        return len(data["documents"]) < original_doc_count

    def purge_all(self):
        """Purges databank.json."""
        self._save_data(self.db_path, {"documents": [], "chunks": []})
        print("[Data Bank] Purged all documents and vectors from databank.")

    def query(self, query_text: str, top_k: int = 5, score_threshold: float = 0.25, exclude_source_type: str = None, token_budget: int = None, query_vector=None) -> str:
        """Queries databank.json vector index and returns contextual matching chunks."""
        data = self._load_data(self.db_path)
        
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
            filtered_chunks.append((doc["name"], chunk["text"], chunk["vector"]))
            
        if not filtered_chunks:
            return ""
            
        if query_vector is None:
            model = get_embedding_model()
            query_vector = model.encode(query_text)
        
        query_norm = np.linalg.norm(query_vector)
        if query_norm == 0:
            return ""
            
        results = []
        for doc_name, chunk_text, vector in filtered_chunks:
            chunk_vector = np.array(vector)
            chunk_norm = np.linalg.norm(chunk_vector)
            if chunk_norm == 0:
                continue
                
            similarity = np.dot(query_vector, chunk_vector) / (query_norm * chunk_norm)
            
            if similarity >= score_threshold:
                results.append((similarity, doc_name, chunk_text))
                
        results.sort(key=lambda x: x[0], reverse=True)
        top_results = results[:top_k]
        
        if not top_results:
            return ""
        
        if token_budget:
            budget_chars = token_budget * 4
            budgeted = []
            char_count = 0
            for result in top_results:
                result_chars = len(result[2])
                if char_count + result_chars > budget_chars and budgeted:
                    break
                budgeted.append(result)
                char_count += result_chars
            top_results = budgeted
        
        best_score = top_results[0][0] if top_results else 0
        best_source = top_results[0][1] if top_results else "none"
        print(f"[RAG] knowledge: {len(top_results)} chunks retrieved (best: {best_score:.3f} from '{best_source}')", flush=True)
            
        formatted_context = []
        for idx, (score, doc_name, text) in enumerate(top_results):
            formatted_context.append(f"[{idx+1}] Source: {doc_name} (Similarity: {score:.2f})\n{text.strip()}")
        return "\n\n".join(formatted_context)

    def delete_chat_history(self, session_id: str = None) -> bool:
        """Deletes chat history documents and chunks from the databank on session reset."""
        data = self._load_data(self.db_path)
        
        # Identify documents designated as chat history
        chat_doc_ids = {
            doc["id"] for doc in data["documents"] 
            if doc.get("source_type") == "chat_history"
        }
        
        if not chat_doc_ids:
            return False

        # Filter out chat history documents and their corresponding vector chunks
        data["documents"] = [d for d in data["documents"] if d["id"] not in chat_doc_ids]
        data["chunks"] = [c for c in data["chunks"] if c["doc_id"] not in chat_doc_ids]

        self._save_data(self.db_path, data)
        print("[Data Bank] Cleaned up chat history on session reset.")
        return True