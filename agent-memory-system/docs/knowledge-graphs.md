# Knowledge Graphs for Agent Memory

## Graph Models

### RDF Triples
```
Subject → Predicate → Object
(module_A) → (imports) → (module_B)
```

Suited for: Semantic web, reasoning, SPARQL queries.

### Property Graphs
```
(:Entity {name: "auth"})-[:REQUIRES]->(:Entity {name: "session"})
```

Suited for: Cypher queries, pathfinding, weighted relationships.

### Hypergraphs
```
Edge connects N nodes
(function) → [reads: file_A, writes: file_B, uses: lib_C]
```

Suited for: Complex multi-way relationships.

## Agent-Specific Patterns

| Pattern | Structure | Query Type |
|---------|-----------|------------|
| Code dependency | Module → imports → Module | "What breaks if I change X?" |
| Conversation thread | Message → replies_to → Message | "Summarize this thread" |
| Concept evolution | Idea → refines → Idea | "Trace design decisions" |
| Tool usage | Task → uses_tool → Tool | "When was grep used?" |

## Storage Backends

| Backend | Scale | Query Speed | Embedding Support |
|---------|-------|-------------|-------------------|
| Neo4j | Large | Fast | Via APOC |
| NebulaGraph | Distributed | Fast | Native |
| RDFlib (Python) | Small | Medium | External |
| NetworkX | In-memory | Fast | External |
| Filesystem* | Medium | Slow | N/A |

*Filesystem: nodes=files, edges=symlinks/references.

## Construction from Text

```
Raw Text → NER → Relation Extraction → Graph Update
```

1. **Named Entity Recognition**: Identify nodes
2. **Coreference Resolution**: Merge duplicates
3. **Relation Classification**: Label edges
4. **Conflict Resolution**: Handle contradictions

## Query Patterns for LLMs

```cypher
// Context expansion
MATCH (n)-[:RELATED*1..2]-(m) WHERE n.name = $concept RETURN m

// Path finding
MATCH p = shortestPath((a)-[*]-(b)) WHERE a.name = $x AND b.name = $y RETURN p

// Anomaly detection
MATCH (n) WHERE NOT (n)-[]-() RETURN n  // Isolated nodes
```

## Challenges

| Issue | Mitigation |
|-------|------------|
| Schema drift | Versioned ontologies |
| Entity disambiguation | Embedding-based clustering |
| Stale relationships | TTL on edges + confidence scores |
| Query complexity | Pre-computed views for common paths |
