import type { NormalizedWebhook, WebhookNormalizer } from "../types.js";

/**
 * {@link WebhookNormalizer} for GitHub webhook events.
 *
 * Handles workflow_run events (and other GitHub events in the future).
 * Extracts key fields for agent processing.
 *
 * @param payload      - Parsed JSON body from the inbound request.
 * @param endpointPath - The interceptor route path that received the webhook.
 */
export const normalizeGithub: WebhookNormalizer = (payload: unknown, endpointPath: string): NormalizedWebhook | null => {
  if (typeof payload !== "object" || payload === null) return null;

  const p = payload as Record<string, unknown>;
  
  // Determine event type from payload structure
  let eventType: string;
  let data: Record<string, unknown>;

  // workflow_run events
  if (p.workflow_run && typeof p.workflow_run === "object") {
    const workflowRun = p.workflow_run as Record<string, unknown>;
    const repo = p.repository as Record<string, unknown> | undefined;
    
    eventType = "workflow_run";
    data = {
      action: p.action, // "completed", "requested", "in_progress"
      conclusion: workflowRun.conclusion, // "success", "failure", "cancelled", etc.
      workflow_id: workflowRun.workflow_id,
      workflow_name: workflowRun.name,
      run_id: workflowRun.id,
      run_number: workflowRun.run_number,
      head_branch: workflowRun.head_branch,
      head_sha: workflowRun.head_sha,
      html_url: workflowRun.html_url,
      created_at: workflowRun.created_at,
      updated_at: workflowRun.updated_at,
      // Repository info
      repo_full_name: repo?.full_name,
      repo_owner: (repo?.owner as Record<string, unknown>)?.login,
      repo_name: repo?.name,
      // For fetching artifacts/continuation file
      artifacts_url: workflowRun.artifacts_url,
    };
  }
  // push events
  else if (p.ref && p.commits) {
    eventType = "push";
    data = {
      ref: p.ref,
      before: p.before,
      after: p.after,
      commits: p.commits,
      repository: (p.repository as Record<string, unknown>)?.full_name,
      pusher: (p.pusher as Record<string, unknown>)?.name,
    };
  }
  // pull_request events
  else if (p.pull_request) {
    const pr = p.pull_request as Record<string, unknown>;
    eventType = "pull_request";
    data = {
      action: p.action,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      html_url: pr.html_url,
      head_branch: (pr.head as Record<string, unknown>)?.ref,
      base_branch: (pr.base as Record<string, unknown>)?.ref,
      repository: (p.repository as Record<string, unknown>)?.full_name,
    };
  }
  // issues events
  else if (p.issue && !p.comment) {
    const issue = p.issue as Record<string, unknown>;
    eventType = "issue";
    data = {
      action: p.action,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      html_url: issue.html_url,
      repository: (p.repository as Record<string, unknown>)?.full_name,
    };
  }
  // issue_comment events
  else if (p.issue && p.comment) {
    const comment = p.comment as Record<string, unknown>;
    eventType = "issue_comment";
    data = {
      action: p.action,
      issue_number: (p.issue as Record<string, unknown>)?.number,
      comment_id: comment.id,
      comment_body: comment.body,
      comment_url: comment.html_url,
      repository: (p.repository as Record<string, unknown>)?.full_name,
    };
  }
  // Unknown GitHub event - still normalize it
  else if (p.repository || p.sender) {
    eventType = String(p.action ?? "unknown");
    data = {
      action: p.action,
      repository: (p.repository as Record<string, unknown>)?.full_name,
      sender: (p.sender as Record<string, unknown>)?.login,
    };
  }
  // Not a GitHub webhook
  else {
    return null;
  }

  return {
    source: "github",
    eventType,
    endpointPath,
    data,
    rawPayload: payload,
    timestamp: new Date().toISOString(),
  };
};
