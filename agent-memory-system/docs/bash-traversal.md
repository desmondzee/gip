# Bash Tool Calls: Directory Graph Traversal

## Principle

Filesystems are graphs. Directories are nodes; containment is edges. Bash tools enable LLM-native graph traversal without custom infrastructure.

## Traversal Primitives

| Tool | Graph Operation | Use Case |
|------|-----------------|----------|
| `ls` | List adjacent nodes | Explore directory contents |
| `find` | BFS/DFS traversal | Locate files by pattern |
| `grep` | Edge following by content | Find files containing concept |
| `cat` | Read node contents | Load file into context |
| `cd` | Move current node | Navigate structure |

## LLM Traversal Patterns

### 1. Breadth-First Discovery
```bash
ls -la                    # Examine current level
find . -maxdepth 1 -type d  # Identify subdirectories
```

### 2. Depth-First Search
```bash
find . -name "*.md" -exec cat {} \;  # Descend and read
```

### 3. Semantic Navigation
```bash
grep -r "concept" . --include="*.md"   # Find by content
cat $(grep -l "concept" *.md)         # Load relevant files
```

### 4. Selective Loading
```bash
wc -l *.md | sort -n | tail -5         # Find largest files
head -50 large-file.md                 # Preview before full load
```

## Graph Metadata

Filesystem provides native graph properties:
- **Timestamps**: Edge weights (recency)
- **Size**: Node weight (content volume)
- **Path depth**: Distance from root
- **Symlinks**: Cross-graph edges

## Optimization Strategies

| Problem | Solution |
|---------|----------|
| Large directories | Use `find` with `-maxdepth` |
| Binary files | Exclude with `-type f -name "*.txt"` |
| Circular symlinks | `find` with `-follow` and cycle detection |
| Slow traversal | Index with `locate` or `fd` |

## Hybrid Approach

Combine bash traversal with in-context graph:

```
1. LLM queries wiki index (in context)
2. Wiki returns file paths
3. Bash tools load files
4. New content updates in-context graph
```

This avoids loading full filesystem into context while enabling exploration.
