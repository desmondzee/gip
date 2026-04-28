#!/bin/bash
# Graph traversal helper for LLM file navigation
# Usage: source graph-nav.sh

# List directory as nodes with metadata
list_nodes() {
    local dir="${1:-.}"
    find "$dir" -maxdepth 1 -type f -o -type d | while read -r path; do
        local name=$(basename "$path")
        local type=$(if [ -d "$path" ]; then echo "DIR"; else echo "FILE"; fi)
        local size=$(if [ -f "$path" ]; then wc -l < "$path" 2>/dev/null || echo "0"; else echo "-"; fi)
        echo "[$type] $name (lines: $size)"
    done
}

# Find files containing concept
find_concept() {
    local concept="$1"
    local dir="${2:-.}"
    grep -r -l "$concept" "$dir" 2>/dev/null | head -20
}

# Show file with line numbers for precise reference
show_file() {
    local file="$1"
    if [ -f "$file" ]; then
        nl -ba "$file"
    else
        echo "File not found: $file"
    fi
}

# Get file neighborhood (files in same dir)
neighborhood() {
    local file="$1"
    local dir=$(dirname "$file")
    echo "=== Directory: $dir ==="
    ls -la "$dir"
}

# Quick stats on notes collection
stats() {
    echo "=== Wiki Stats ==="
    echo "Total files: $(find . -type f | wc -l)"
    echo "Total lines: $(find . -type f -exec wc -l {} + 2>/dev/null | tail -1 | awk '{print $1}')"
    echo "Notes: $(find notes -type f 2>/dev/null | wc -l)"
    echo "Docs: $(find docs -type f 2>/dev/null | wc -l)"
}
