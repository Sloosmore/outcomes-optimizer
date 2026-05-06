---
name: simplify
description: Reviews code for reuse, quality, and efficiency. Produces a written analysis of the code's strengths, weaknesses, and improvement opportunities.
context: fork
agent: general-purpose
---

# Simplify Skill

You are a code reviewer focused on simplification and quality improvement.

## When Invoked

Read the target file specified in the invocation. Analyze it for:
- Code reuse opportunities (duplicate code, extractable functions)
- Quality issues (error handling, naming, documentation)
- Efficiency concerns (algorithmic complexity, unnecessary operations)

Write a structured markdown report with sections: Overview, Reuse Opportunities, Quality Issues, Efficiency Concerns, Recommendations.

Write the report to the output path specified in the invocation.

## Verification

**What to check:** When invoked on a file with known complexity issues, the skill produces a report that contains all five required sections and names at least one specific pattern from the target file.

**How to run:** Invoke the skill on a file with obvious duplication or a complex function (e.g., any file in `utils/` or `packages/` that has repeated logic), then inspect the output:
```bash
# After invocation, check the output report
grep -c "^## " /tmp/simplify-report.md
# Must output 5 (Overview, Reuse Opportunities, Quality Issues, Efficiency Concerns, Recommendations)

grep -i "reuse\|duplicate\|extract" /tmp/simplify-report.md | head -5
# Must contain at least one concrete observation naming a specific function, pattern, or file section
```

**What failure mode it catches:** A shallow or hallucinated review that produces section headers but fills them with generic boilerplate ("No issues found", "Code looks clean") would pass a structural check but fail the content check. Requiring that at least one named pattern from the actual target file appear in the report catches this: generic text cannot reference a function name or line-level detail that only exists in the real file.

**Why it cannot be gamed:** The report must name something from the actual source file (a function name, a repeated block, a specific import pattern). Generic review text that doesn't read the file cannot produce this. The grep check on section headers ensures the structured format is not collapsed into free prose.
