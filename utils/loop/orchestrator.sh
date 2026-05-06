#!/bin/bash
# Ralph Loop Orchestrator
# Usage: ./orchestrator.sh "goal description" [options]
#
# Options:
#   --max-epochs N    Maximum loop epochs (default: 10)
#   --test-set PATH   Path to test set file/folder, or URL
#
# If no test set provided, the agent will attempt to generate one.

set -e

# Defaults
GOAL=""
MAX_EPOCHS=10
TEST_SET=""

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --help|-h)
      echo "Usage: ./orchestrator.sh \"goal description\" [options]"
      echo ""
      echo "Options:"
      echo "  --max-epochs N    Maximum loop epochs (default: 10)"
      echo "  --test-set PATH   Path to test set file/folder, or URL"
      echo ""
      echo "If no test set provided, the agent will attempt to generate one."
      exit 0
      ;;
    --max-epochs)
      MAX_EPOCHS="$2"
      shift 2
      ;;
    --test-set)
      TEST_SET="$2"
      shift 2
      ;;
    *)
      # First positional arg is the goal
      if [ -z "$GOAL" ]; then
        GOAL="$1"
      fi
      shift
      ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="$(pwd)/workspace"
PROGRESS_FILE="$WORKSPACE/progress.md"
PROMPTS_DIR="$WORKSPACE/prompts"

# Validate input
if [ -z "$GOAL" ]; then
  echo "Usage: ./orchestrator.sh \"goal description\" [options]"
  exit 1
fi

# Initialize workspace
mkdir -p "$WORKSPACE" "$PROMPTS_DIR"

# Initialize progress file if new run
if [ ! -f "$PROGRESS_FILE" ]; then
  cat > "$PROGRESS_FILE" << EOF
# Progress Log

**Goal**: $GOAL
**Started**: $(date)

---
EOF
fi

# Initialize prd.json if not exists
PRD_FILE="$WORKSPACE/prd.json"
if [ ! -f "$PRD_FILE" ]; then
  cat > "$PRD_FILE" << EOF
{
  "goal": "$GOAL",
  "stories": []
}
EOF
  echo "Created empty prd.json - leader will populate stories on first epoch"
fi

# Get traces path (Claude Code stores traces here)
TRACES_PATH="$HOME/.claude/projects"

echo "Starting Ralph Loop"
echo "Goal: $GOAL"
echo "Max sessions: $MAX_EPOCHS"
echo "Test set: ${TEST_SET:-"(agent will generate)"}"
echo "Traces: $TRACES_PATH"
echo ""

# Determine starting epoch from state.json (continue from last epoch + 1)
STATE_FILE="$WORKSPACE/state.json"
START_EPOCH=1
if [ -f "$STATE_FILE" ]; then
  LAST_EPOCH=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).epoch||0)" 2>/dev/null || echo "0")
  if [ "$LAST_EPOCH" -gt 0 ] 2>/dev/null; then
    START_EPOCH=$((LAST_EPOCH + 1))
    echo "Resuming from state.json: last completed epoch $LAST_EPOCH, starting at epoch $START_EPOCH"
  fi
fi
END_EPOCH=$((START_EPOCH + MAX_EPOCHS - 1))

# Track progress to detect thrashing
NO_PROGRESS_COUNT=0
LAST_PRD_HASH=""

for i in $(seq $START_EPOCH $END_EPOCH); do
  SESSIONS_RUN=$((i - START_EPOCH + 1))
  echo "==============================================================="
  echo "  Epoch $i (session $SESSIONS_RUN of $MAX_EPOCHS)"
  echo "==============================================================="

  # Check for completion
  if grep -q "^COMPLETE" "$PROGRESS_FILE" 2>/dev/null; then
    echo ""
    echo "COMPLETE signal found in progress.md"
    echo "Finished at epoch $i"
    exit 0
  fi

  # Build the prompt
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%S")
  PROMPT_FILE="$PROMPTS_DIR/epoch-${i}-${TIMESTAMP}.md"

  # Inject variables into leader template
  EPOCH=$i \
  MAX_EPOCHS=$END_EPOCH \
  TRACES_PATH="$TRACES_PATH" \
  envsubst < "$SCRIPT_DIR/SYSTEM.md" > "$PROMPT_FILE"

  # Append optimization framework
  cat "$SCRIPT_DIR/../prompts/optimization.md" >> "$PROMPT_FILE"

  # Append the goal
  cat >> "$PROMPT_FILE" << EOF

---

# Your Goal

$GOAL
EOF

  # Append test set info if provided
  if [ -n "$TEST_SET" ]; then
    cat >> "$PROMPT_FILE" << EOF

## Test Set

Use this test set for validation: $TEST_SET

If this is a file path, read it. If it's a URL, fetch it.
EOF
  else
    cat >> "$PROMPT_FILE" << EOF

## Test Set

No test set provided. You MUST generate your own test set before optimization:
1. Create representative test cases that cover edge cases
2. Save to workspace/test-set/
3. Use these consistently across all epochs
EOF
  fi

  echo "Prompt saved to: $PROMPT_FILE"
  echo ""

  # Run Claude Code and capture session ID
  # Model ID mirrors CLAUDE_FALLBACK_MODEL in utils/types.ts — update both together.
  OUTPUT=$(claude -p "$(cat "$PROMPT_FILE")" \
    --model claude-opus-4-7 \
    --dangerously-skip-permissions \
    --output-format stream-json \
    --verbose \
    2>&1 | tee "$WORKSPACE/epoch-${i}.log") || true

  # Extract session ID from output and log it
  SESSION_ID=$(echo "$OUTPUT" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
  if [ -n "$SESSION_ID" ]; then
    echo "$SESSION_ID" >> "$WORKSPACE/sessions.txt"
    echo "Session ID: $SESSION_ID"
    echo "Trace: $TRACES_PATH/*/$SESSION_ID.jsonl"
  fi

  # Check for thrashing (no progress in prd.json)
  CURRENT_PRD_HASH=$(sha256sum "$PRD_FILE" 2>/dev/null | cut -d' ' -f1 || echo "none")
  if [ "$CURRENT_PRD_HASH" = "$LAST_PRD_HASH" ]; then
    NO_PROGRESS_COUNT=$((NO_PROGRESS_COUNT + 1))
    echo "Warning: No prd.json changes this epoch ($NO_PROGRESS_COUNT consecutive)"
    if [ $NO_PROGRESS_COUNT -ge 3 ]; then
      echo "ERROR: 3 epochs with no progress. Possible thrashing. Aborting."
      exit 1
    fi
  else
    NO_PROGRESS_COUNT=0
  fi
  LAST_PRD_HASH="$CURRENT_PRD_HASH"

  echo ""
  echo "Epoch $i complete."
  sleep 2
done

echo ""
echo "Reached max sessions ($MAX_EPOCHS) — epoch budget exhausted (not a failure). Last epoch: $END_EPOCH"
echo "Check $PROGRESS_FILE for partial results."
exit 0
