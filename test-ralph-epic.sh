#!/bin/bash
# test-ralph-epic.sh - Test script for markplane-ralph-epic
# Creates a temporary git repo and runs the script with the mock agent

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_AGENT="$SCRIPT_DIR/mock-agent.sh"
TEST_DIR=$(mktemp -d)

echo "=== Test Setup ==="
echo "Script directory: $SCRIPT_DIR"
echo "Test directory: $TEST_DIR"
echo "Mock agent: $MOCK_AGENT"
echo ""

# Verify mock agent exists
if [ ! -f "$MOCK_AGENT" ]; then
    echo "ERROR: Mock agent not found at $MOCK_AGENT"
    exit 1
fi

# Make sure scripts are executable
chmod +x "$MOCK_AGENT"
chmod +x "$SCRIPT_DIR/markplane-ralph-epic"

# Create test git repository
echo "=== Creating Test Repository ==="
cd "$TEST_DIR"
git init
git config user.email "test@example.com"
git config user.name "Test User"

# Create initial files
mkdir -p src
echo "# Test Project" > README.md
echo "export const app = () => {};" > src/index.ts
git add .
git commit -m "Initial commit"

# Create a main branch for reference
git branch -M main

echo "Repository initialized with main branch"
echo ""

# Run the ralph-epic script with mock agent
echo "=== Running markplane-ralph-epic with Mock Agent ==="
echo ""

# Run with limited iterations, no-push, and no-sleep for fast testing
"$SCRIPT_DIR/markplane-ralph-epic" \
    --agent-cmd "$MOCK_AGENT" \
    --max-iterations 10 \
    --no-push \
    --no-sleep \
    "$TEST_DIR"

# Show results
echo ""
echo "=== Test Results ==="
echo ""
echo "Branches created:"
git branch -a

echo ""
echo "Commit log (all branches):"
git log --oneline --all --graph --decorate

echo ""
echo "Files created:"
find src -type f -name "*.ts" 2>/dev/null | sort || echo "(none)"

echo ""
echo "=========================================="
echo "Test completed successfully!"
echo "=========================================="
echo ""
echo "Test directory: $TEST_DIR"
echo "To explore: cd $TEST_DIR && git log --all --oneline"
echo "To clean up: rm -rf $TEST_DIR"
