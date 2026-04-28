# LLM Wiki Index

## Quick Navigation

| Tag | Description | Files |
|-----|-------------|-------|
| #architecture | System design patterns | `docs/memory-architecture.md`, `docs/progressive-disclosure.md` |
| #graph | Graph database concepts | `docs/knowledge-graphs.md`, `docs/progressive-disclosure.md` |
| #traversal | File/directory traversal | `docs/bash-traversal.md` |
| #ingestion | Memory ingestion patterns | `docs/incremental-ingestion.md` |
| #bottlenecks | Known limitations | `docs/memory-architecture.md` |

## Concept Map

```
[Memory Architecture]
    ├── [Progressive Disclosure]
    │       └── uses: [Graph DB]
    ├── [Bash Traversal]
    │       └── enables: [Directory Graph Navigation]
    ├── [Knowledge Graphs]
    │       └── stores: [Semantic Relationships]
    └── [Incremental Ingestion]
            └── feeds into: [Knowledge Graphs]
```

## File Registry

| File | Purpose | Key Terms |
|------|---------|-----------|
| `docs/progressive-disclosure.md` | Layered info retrieval | context window, relevance scoring, lazy loading |
| `docs/bash-traversal.md` | LLM directory navigation | ls, find, grep, graph traversal |
| `docs/knowledge-graphs.md` | Graph-based memory | entities, relations, RDF, property graphs |
| `docs/incremental-ingestion.md` | Streaming memory updates | embeddings, chunking, deduplication |
| `docs/memory-architecture.md` | State of the art survey | STM, LTM, episodic, semantic |
| `notes/` | Raw agent notes | Unstructured observations |
| `scratchpad/` | Working thoughts | Ephemeral, in-progress |

## Search Shortcuts

- **Find by tag**: Search `#<tag>` in this file
- **Find by concept**: Check "Key Terms" in registry
- **Recent changes**: Check git log or file timestamps
