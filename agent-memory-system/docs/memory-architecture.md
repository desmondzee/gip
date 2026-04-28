# Memory Architecture for LLM Agents: State of the Art

## Memory Taxonomy

```
Memory
├── Short-Term (STM)
│   ├── Working: Active context window
│   └── Episodic: Recent interactions
├── Long-Term (LTM)
│   ├── Semantic: Facts, concepts
│   ├── Procedural: Skills, patterns
│   └── Episodic: Past experiences
└── External
    ├── Vector: Embedding-based retrieval
    ├── Graph: Structured relationships
    └── Tool: On-demand computation
```

## State of the Art (2024-2025)

### Retrieval-Augmented Generation (RAG)
- **Dense Passage Retrieval**: DPR, Contriever
- **Hybrid Search**: BM25 + semantic fusion
- **Multi-hop**: Iterative retrieval for complex queries

### Memory-Augmented Networks
- **MemGPT**: OS-inspired memory management
- **Voyager**: Skill library with code generation
- **Generative Agents**: Sandbox simulations with reflective memory

### Context Compression
- **Hierarchical Summarization**: Recursive episode compression
- **Selective Attention**: Key-value cache pruning
- **Token Routing**: MoE-style context gating

## Key Bottlenecks

| Bottleneck | Cause | Impact |
|------------|-------|--------|
| Context limits | Fixed window size | Lost information |
| Retrieval noise | Embedding ambiguity | Wrong facts |
| Latency | DB round-trips | Slow responses |
| Consistency | No global state | Contradictory outputs |
| Attribution | Opaque retrieval | Untrustworthy answers |

## Research Directions

### 1. Learned Retrieval
Train retriever end-to-end with generator. REPLUG, In-Context Retrieval Learning.

### 2. Differentiable Memory
Neural Turing Machines, Memory Networks—full gradient through storage.

### 3. Structured Memory
Code as memory (Voyager), knowledge graphs with neural operators.

### 4. Multimodal Memory
Unified embedding spaces for text, image, audio, video.

### 5. Episodic Replay
Experience replay for continual learning without forgetting.

## What Needs Improvement

1. **Temporal Reasoning**: Most systems treat memory as static. Agents need time-aware retrieval.

2. **Uncertainty Quantification**: Retrieval confidence should affect generation.

3. **Causal Understanding**: Current graphs capture correlation, not causation.

4. **Efficient Updates**: Incremental index updates remain expensive at scale.

5. **Human-Readable Memory**: Debuggable, editable agent memory for oversight.

6. **Cross-Session Persistence**: True long-term memory across restarts, not just within-session.

## Emerging Patterns

| Pattern | Description |
|---------|-------------|
| Memory hierarchies | L1: context, L2: cache, L3: store |
| Write-through | All memory layers updated synchronously |
| Reflection loops | Periodic consolidation of episodic → semantic |
| Tool-augmented recall | Bash, SQL, APIs as memory interfaces |
