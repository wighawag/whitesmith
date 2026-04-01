#!/bin/bash
# test-branch-skip.sh - Test that epics with existing branches are skipped
# This tests the fix for the infinite loop issue where completed epics
# were being rediscovered because their status updates were on the branch,
# not on main.
#
# Usage: test-branch-skip.sh [--typescript]
#   --typescript  Test the TypeScript implementation (src/index.ts)
#   (default)     Test the bash implementation (markplane-ralph-epic)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_AGENT="$SCRIPT_DIR/mock-agent.sh"
TEST_DIR=$(mktemp -d)
PASSED=0
FAILED=0

# Check for --typescript flag
USE_TYPESCRIPT=false
if [ "$1" = "--typescript" ] || [ "$1" = "-ts" ]; then
    USE_TYPESCRIPT=true
fi

# Determine which implementation to test
if [ "$USE_TYPESCRIPT" = true ]; then
    RALPH_SCRIPT="npx tsx $SCRIPT_DIR/src/index.ts"
    IMPL_NAME="TypeScript (src/index.ts)"
else
    RALPH_SCRIPT="$SCRIPT_DIR/markplane-ralph-epic"
    IMPL_NAME="Bash (markplane-ralph-epic)"
fi

echo "=== Test: Branch Skip Behavior ==="
echo "Script directory: $SCRIPT_DIR"
echo "Test directory: $TEST_DIR"
echo "Implementation: $IMPL_NAME"
echo ""

# Verify scripts exist
if [ ! -f "$MOCK_AGENT" ]; then
    echo "ERROR: Mock agent not found at $MOCK_AGENT"
    exit 1
fi

# Make scripts executable
chmod +x "$MOCK_AGENT"
if [ "$USE_TYPESCRIPT" = false ]; then
    chmod +x "$SCRIPT_DIR/markplane-ralph-epic"
fi

# ============================================
# TEST 1: Epic with branch should be skipped
# ============================================
echo "=== TEST 1: Epic with existing branch should be skipped ==="
echo ""

# Create test git repository
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
git branch -M main

# Simulate that EPIC-001 was completed: create its branch with some work
echo "Creating completed epic branch for EPIC-001..."
git checkout -b ralph/epic-EPIC-001-user-authentication

mkdir -p src/epic-001
cat > src/epic-001/task-1.ts << 'EOF'
// User Authentication - Task 1
export function task1() { return true; }
EOF
git add .
git commit -m "feat(EPIC-001): implement task 1"

# Go back to main (simulating script restart)
git checkout main

# Clear any state file
rm -f .ralph-epic-state
rm -f .mock-agent-state

echo ""
echo "Current branches:"
git branch -a
echo ""

# Run the script with just 1 iteration to see which epic is discovered
echo "Running ralph-epic with 1 iteration to test discovery..."
echo ""

# Capture the output
OUTPUT=$(eval "$RALPH_SCRIPT" \
    --agent-cmd '"$MOCK_AGENT"' \
    --max-iterations 1 \
    --no-push \
    --no-sleep \
    '"$TEST_DIR"' 2>&1) || true

echo "$OUTPUT"
echo ""

# Check that EPIC-001 was skipped and EPIC-002 was discovered
if echo "$OUTPUT" | grep -q "Discovered epic: EPIC-002"; then
    echo "✅ TEST 1 PASSED: EPIC-001 was correctly skipped, EPIC-002 was discovered"
    PASSED=$((PASSED + 1))
else
    echo "❌ TEST 1 FAILED: Expected EPIC-002 to be discovered (skipping EPIC-001)"
    FAILED=$((FAILED + 1))
fi

echo ""

# ============================================
# TEST 2: Verify STATE_FILE epic is excluded from skip list
# ============================================
echo "=== TEST 2: STATE_FILE epic should NOT be in skip list ==="
echo ""

# Create a fresh test directory for this test
TEST_DIR2=$(mktemp -d)
cd "$TEST_DIR2"
git init
git config user.email "test@example.com"
git config user.name "Test User"

mkdir -p src
echo "# Test Project" > README.md
git add .
git commit -m "Initial commit"
git branch -M main

# Create branch for EPIC-001 (completed)
git checkout -b ralph/epic-EPIC-001-user-authentication
echo "task1" > src/task1.ts
git add .
git commit -m "feat(EPIC-001): complete"

# Create branch for EPIC-002 (in progress - will be in STATE_FILE)
git checkout -b ralph/epic-EPIC-002-dashboard-ui
echo "partial" > src/task2.ts
git add .
git commit -m "feat(EPIC-002): partial work"

git checkout main

# Create partial STATE_FILE (has EPIC_ID but no BRANCH_NAME - triggers discovery but also marks it as in-progress)
cat > .ralph-epic-state << 'EOF'
SAVED_EPIC_ID="EPIC-002"
SAVED_EPIC_NAME="Dashboard UI"
EOF

rm -f .mock-agent-state

echo "Branches:"
git branch | grep ralph
echo ""
echo "STATE_FILE (partial - will trigger discovery):"
cat .ralph-epic-state
echo ""

# Create a test mock that shows us what's in the skip list
cat > "$TEST_DIR2/test-mock.sh" << 'MOCKEOF'
#!/bin/bash
PROMPT="$1"
echo "=== ANALYZING DISCOVERY PROMPT ==="

# Check what epics are in the skip list
if echo "$PROMPT" | grep -q "already have branches"; then
    echo "Skip list found in prompt:"
    echo "$PROMPT" | grep -E "^\s*-" | head -5
else
    echo "No skip list found"
fi

echo ""

# Verify EPIC-002 is NOT in the skip list (since it's in STATE_FILE)
if echo "$PROMPT" | grep -E "^\s*-\s*EPIC-002" > /dev/null; then
    echo "RESULT: EPIC-002 IS in skip list (BAD)"
    echo "STATUS: FAIL"
else
    echo "RESULT: EPIC-002 is NOT in skip list (GOOD - STATE_FILE exclusion works)"
    echo "STATUS: PASS"
fi

# Output valid discovery response to satisfy the script
echo ""
echo "EPIC_ID: EPIC-003"
echo "EPIC_NAME: API Integration"
echo "DEPENDS_ON: EPIC-002"
MOCKEOF
chmod +x "$TEST_DIR2/test-mock.sh"

OUTPUT2=$(eval "$RALPH_SCRIPT" \
    --agent-cmd '"$TEST_DIR2/test-mock.sh"' \
    --max-iterations 1 \
    --no-push \
    --no-sleep \
    '"$TEST_DIR2"' 2>&1) || true

echo "$OUTPUT2"
echo ""

if echo "$OUTPUT2" | grep -q "STATUS: PASS"; then
    echo "✅ TEST 2 PASSED: STATE_FILE epic correctly excluded from skip list"
    PASSED=$((PASSED + 1))
elif echo "$OUTPUT2" | grep -q "STATUS: FAIL"; then
    echo "❌ TEST 2 FAILED: STATE_FILE epic should NOT be in skip list"
    FAILED=$((FAILED + 1))
else
    echo "⚠️ TEST 2 INCONCLUSIVE: Could not determine result"
    FAILED=$((FAILED + 1))
fi

echo ""

# ============================================
# TEST 3: All epics with branches = COMPLETE signal
# ============================================
echo "=== TEST 3: All epics with branches should trigger RALPH_COMPLETE ==="
echo ""

# Create a fresh test directory
TEST_DIR3=$(mktemp -d)
cd "$TEST_DIR3"
git init
git config user.email "test@example.com"
git config user.name "Test User"

mkdir -p src
echo "# Test Project" > README.md
git add .
git commit -m "Initial commit"
git branch -M main

# Create branches for ALL epics
for epic in EPIC-001 EPIC-002 EPIC-003; do
    git checkout -b "ralph/epic-${epic}-completed"
    echo "done" > "src/${epic}.ts"
    git add .
    git commit -m "feat(${epic}): complete"
done

git checkout main

rm -f .ralph-epic-state
rm -f .mock-agent-state

echo "Branches (all epics):"
git branch | grep ralph
echo ""

OUTPUT3=$(eval "$RALPH_SCRIPT" \
    --agent-cmd '"$MOCK_AGENT"' \
    --max-iterations 1 \
    --no-push \
    --no-sleep \
    '"$TEST_DIR3"' 2>&1) || true

echo "$OUTPUT3"
echo ""

if echo "$OUTPUT3" | grep -q "ALL EPICS COMPLETED"; then
    echo "✅ TEST 3 PASSED: All epics with branches correctly identified as complete"
    PASSED=$((PASSED + 1))
else
    echo "❌ TEST 3 FAILED: Expected RALPH_COMPLETE when all epics have branches"
    FAILED=$((FAILED + 1))
fi

echo ""

# ============================================
# TEST 4: Max iterations reached should not cause syntax error
# ============================================
echo "=== TEST 4: Max iterations reached should complete without errors ==="
echo ""

# Create a fresh test directory
TEST_DIR4=$(mktemp -d)
cd "$TEST_DIR4"
git init
git config user.email "test@example.com"
git config user.name "Test User"

mkdir -p src
echo "# Test Project" > README.md
git add .
git commit -m "Initial commit"
git branch -M main

rm -f .ralph-epic-state
rm -f .mock-agent-state

# Run with exactly 2 iterations to test iteration limit behavior
# The script should run 2 iterations and exit gracefully
OUTPUT4=$(eval "$RALPH_SCRIPT" \
    --agent-cmd '"$MOCK_AGENT"' \
    --max-iterations 2 \
    --no-push \
    --no-sleep \
    '"$TEST_DIR4"' 2>&1)
EXIT_CODE4=$?

echo "$OUTPUT4"
echo ""
echo "Exit code: $EXIT_CODE4"
echo ""

# Check for syntax errors
if echo "$OUTPUT4" | grep -q "syntax error"; then
    echo "❌ TEST 4 FAILED: Syntax error detected"
    FAILED=$((FAILED + 1))
elif [ $EXIT_CODE4 -ne 0 ]; then
    echo "❌ TEST 4 FAILED: Script exited with error code $EXIT_CODE4"
    FAILED=$((FAILED + 1))
elif echo "$OUTPUT4" | grep -q "Iteration limit reached"; then
    echo "✅ TEST 4 PASSED: Max iterations reached without errors"
    PASSED=$((PASSED + 1))
else
    echo "⚠️ TEST 4 INCONCLUSIVE: Could not verify behavior"
    FAILED=$((FAILED + 1))
fi

echo ""

# ============================================
# Summary
# ============================================
echo "=========================================="
echo "Test Summary: $PASSED passed, $FAILED failed"
echo "=========================================="
echo ""
echo "Test directories:"
echo "  - $TEST_DIR"
echo "  - $TEST_DIR2"
echo "  - $TEST_DIR3"
echo "  - $TEST_DIR4"
echo ""
echo "To clean up: rm -rf $TEST_DIR $TEST_DIR2 $TEST_DIR3 $TEST_DIR4"

if [ $FAILED -gt 0 ]; then
    exit 1
fi
