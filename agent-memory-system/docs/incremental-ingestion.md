# Incremental Memory Ingestion

## Problem

Agents accumulate information continuously. Re-embedding entire memory is O(N) and expensive. Incremental ingestion maintains O(ΔN) complexity.

## Pipeline

```
New Input → Deduplication → Chunking → Embedding → Index Update → Graph Link
```

## Stages

### 1. Deduplication
```python
# Semantic dedup via embeddings
new_embedding = embed(input)
similar = index.query(new_embedding, threshold=0.95)
if similar:
    merge_or_skip(input, similar)
```

### 2. Adaptive Chunking
| Content Type | Strategy | Size |
|--------------|----------|------|
| Code | AST boundaries | Function/class |
| Prose | Semantic paragraphs | 2-4 sentences |
| Logs | Time windows | 5-min buckets |
| Conversations | Turn boundaries | Per message |

### 3. Embedding Storage

**Local**: sentence-transformers, fast for small scale.
**API**: OpenAI, Cohere—better quality, latency cost.
**Hybrid**: Local for dedup, API for final storage.

### 4. Index Update

| Index Type | Update Complexity | Use Case |
|------------|-------------------|----------|
| Flat (brute force) | O(N) | Small datasets |
| HNSW | O(log N) | Large, dynamic |
| IVF | O(√N) | Balanced |

### 5. Graph Linking

```cypher
// Link new chunk to related concepts
MATCH (c:Concept) WHERE c.embedding =~ $new_embedding
MERGE (new:Chunk {id: $id})
MERGE (new)-[:RELATES {strength: similarity}]->(c)
```

## Conflict Resolution

| Conflict | Resolution |
|----------|------------|
| Contradictory facts | Timestamp + confidence weighting |
| Duplicate entities | Canonicalization via clustering |
| Stale information | Time-decay on relevance |

## Backpressure Strategies

When ingestion exceeds processing capacity:

1. **Sampling**: Process every Nth item
2. **Summarization**: Compress before storing
3. **Tiered storage**: Hot (context) → Warm (vector DB) → Cold (disk)
4. **Drop policy**: LRU or importance-weighted eviction

## Implementation Sketch

```python
class IncrementalIngestion:
    def ingest(self, item):
        if self.is_duplicate(item):
            return self.merge(item)
        chunks = self.chunk(item)
        for chunk in chunks:
            emb = self.embed(chunk)
            self.index.add(chunk.id, emb)
            self.link_to_graph(chunk, emb)
        self.update_wiki_index(chunks)
```
