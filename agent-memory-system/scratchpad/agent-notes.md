# Agent Scratchpad: Memory System Design Notes

## 2025-01-28: System Setup

### Design Decisions Made

1. **Filesystem over Graph DB**: Chose bash/file-based approach because:
   - Zero infrastructure dependencies
   - Human-readable and version-controllable
   - LLMs already have bash/ls/cat tools
   - Avoids vendor lock-in to Neo4j/etc

2. **Wiki Layer Pattern**: Created INDEX.md as explicit concept map rather than auto-generated index because:
   - Self-documenting structure
   - LLM can edit it directly
   - Survives without compute resources

3. **Four-Layer Disclosure**:
   - L1: Wiki INDEX (always in context pointer)
   - L2: Docs summaries (loaded by query)
   - L3: Full research docs (on demand)
   - L4: Raw notes (ephemeral, high volume)

### Open Questions

- How to handle notes that grow too large for single file?
- Should we implement automatic wiki index updates on note creation?
- What's the eviction policy when context fills?

### Potential Enhancements

1. **Auto-tagging**: Use LLM to extract #tags from notes and update INDEX
2. **Embedding cache**: Store note embeddings alongside files for semantic search
3. **Temporal indexing**: Add date-based navigation for episodic memory
4. **Conflict detection**: If two notes contradict, flag for review

### Research Gaps Identified

From the architecture survey:

1. **Time-aware retrieval**: Most RAG is static. Need: "What did I know on date X?"
2. **Causal graphs**: Current KG captures "A related to B" not "A causes B"
3. **Human-in-the-loop editing**: How does user correct agent's memory?

### Bash Tool Observations

The `graph-nav.sh` helper functions feel natural for LLM use:
- `list_nodes` → maps to `ls` intuition
- `find_concept` → maps to `grep` intuition
- `neighborhood` → maps to "show me nearby files"

This suggests filesystem-as-API is viable.

### Next Steps

1. Test traversal with real queries
2. Create sample notes to validate ingestion pattern
3. Consider git integration for memory versioning
