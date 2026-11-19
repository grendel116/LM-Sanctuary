---
name: vectorized_databank
description: Use local vector embeddings to retrieve data for queries.
summary: "Contextual knowledge retrieval from ingested documents (automatic)"
retrieval: vector
triggers: databank, knowledge base, uploaded document, ingested file
---
# SKILL: Vectorized Data Bank
1. Prioritize `# KNOWLEDGE BASE CONTEXT` snippets when answering questions.
2. Cite sources organically (e.g., "according to [source]").
3. Do not mention "injected context" or "RAG pipeline". Treat it as integrated knowledge.