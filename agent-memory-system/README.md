# Agent Memory System

A lightweight memory architecture for LLM agents using progressive disclosure and filesystem-based graph traversal.

## Quick Start

```bash
# Navigate the knowledge graph
source wiki/graph-nav.sh
list_nodes docs/
find_concept "RAG" .

# Browse the wiki
cat wiki/INDEX.md
```

## Structure

```
agent-memory-system/
├── wiki/          # LLM-navigable index and tools
│   ├── INDEX.md   # Concept map and file registry
│   └── graph-nav.sh  # Bash traversal helpers
├── docs/          # Human-readable research (5 topics)
├── notes/         # Raw agent observations
└── scratchpad/    # Working notes and ephemeral thoughts
```

## Documentation

| Topic | File |
|-------|------|
| Progressive Disclosure | `docs/progressive-disclosure.md` |
| Bash Directory Traversal | `docs/bash-traversal.md` |
| Knowledge Graphs | `docs/knowledge-graphs.md` |
| Incremental Ingestion | `docs/incremental-ingestion.md` |
| Memory Architecture Survey | `docs/memory-architecture.md` |

## Design Principles

1. **No heavy infrastructure**: Filesystem as graph DB
2. **LLM-native**: Bash tools for traversal; markdown for content
3. **Progressive disclosure**: Wiki index → summaries → full docs → raw notes
4. **Human-readable**: All memory inspectable and editable
