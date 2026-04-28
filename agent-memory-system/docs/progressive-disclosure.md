# Progressive Disclosure: LLM Wiki over Graph DB

## Core Concept

Progressive disclosure loads information in layers—surface first, depth on demand. For LLM agents, this prevents context overflow while maintaining access to deep knowledge.

## Architecture

```
Layer 1: Wiki Index (always loaded)
    └─→ pointers to layer 2

Layer 2: Concept Summaries (loaded by relevance)
    └─→ pointers to layer 3

Layer 3: Full Documents (loaded on explicit request)
    └─→ pointers to raw notes

Layer 4: Raw Notes (ingested as needed)
```

## Graph DB Integration

Nodes represent concepts/documents; edges represent relationships. The LLM wiki sits above as a queryable index.

| Component | Function | Example |
|-----------|----------|---------|
| Wiki Index | Fast concept→file mapping | "Find #architecture files" |
| Graph DB | Semantic relationships | "What depends on auth?" |
| Traversal | Navigate connections | BFS from current context |

## Relevance Scoring

```python
score(node) = α·semantic_similarity + β·recency + γ·access_frequency
```

Nodes above threshold enter context; others remain addressable via tool calls.

## Implementation

1. **Indexing**: Tag documents with concepts at ingest
2. **Query**: LLM generates search → wiki resolves to files
3. **Load**: High-scoring content added to context
4. **Evict**: LRU removal when context full

## Trade-offs

| Approach | Latency | Coverage | Complexity |
|----------|---------|----------|------------|
| Full RAG | Low | High | Medium |
| Progressive | Medium | Selective | High |
| Pure Context | Zero | Limited | Low |

Progressive disclosure suits long-running agents with evolving context.
