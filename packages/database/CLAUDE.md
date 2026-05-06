## Architectural Boundary — Data Access Only

This package is pure data access. Services here translate between application code and the database — SELECT, INSERT, UPDATE, DELETE. Nothing else.

**Business rules do not belong here.** If you find yourself writing logic like "check if a project with this name already exists before inserting" inside a service, stop. That rule belongs in the action layer.

### Where business rules live

The `action_types` table (in `utils/database/actions/`) is the registry for all write-time business rules. Each action declares its constraints in `validation_rules` (jsonb), and `execute-action.ts` enforces them before the RPC runs:

```json
{
  "uniqueness": [
    {
      "table": "resources",
      "where": { "type": "project" },
      "field": "name",
      "input_field": "name",
      "error": "A project with this name already exists"
    }
  ]
}
```

Adding a constraint to a new resource type means updating a row in `action_types` — not adding code to a service.

### The rule of thumb

| Belongs here (database package) | Belongs in action_types |
|---|---|
| `WHERE type = 'project' AND name = $name` | "no two projects may share a name" |
| `UPDATE resources SET name = $name WHERE id = $id` | "name must be unique before updating" |
| `INSERT INTO processes (project_id, ...)` | "project_id must reference a real project" |
| Pagination, ordering, filtering | Field validation, cross-field constraints |

If the logic answers "can this write happen?" — it's an action rule. If it answers "how do I read or write this data?" — it belongs here.

> E2E verification requirements live in the flow graph — see flow skills via `npx agent-core search "flow/" --type skill`
