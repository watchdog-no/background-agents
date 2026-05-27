function buildCustomInstructionsSection(instructions: string | null | undefined): string {
  if (!instructions?.trim()) return "";
  return `\n## Custom Instructions\n${instructions}`;
}

function buildCommentGuidelines(isPublicRepo: boolean): string {
  const visibility = isPublicRepo
    ? "\n- This is a PUBLIC repository. Be especially careful not to expose secrets, internal URLs, or infrastructure details."
    : "\n- This is a private repository, but still avoid leaking infrastructure details in comments.";
  return `
## Comment Guidelines
- Summarize command output (e.g. "All 559 tests pass"), never paste raw terminal logs.
- Do not include internal infrastructure details (sandbox IDs, object IDs, log output) in comments.${visibility}
- Compose your full response before posting any comments.`;
}

// Wraps a field's text in a tag named for what it is. Escaping keeps content
// from closing the tag early, so the block boundaries stay intact.
function wrapUntrusted(tag: string, content: string): string {
  const escaped = content
    .replaceAll(`</${tag}>`, `<\\/${tag}>`)
    .replaceAll(`<${tag}>`, `<\\${tag}>`);
  return `<${tag}>\n${escaped}\n</${tag}>`;
}

export function buildCodeReviewPrompt(params: {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  author: string;
  base: string;
  head: string;
  isPublic: boolean;
  codeReviewInstructions?: string | null;
}): string {
  const { owner, repo, number, title, body, author, base, head, isPublic, codeReviewInstructions } =
    params;

  return `You are reviewing Pull Request #${number} in ${owner}/${repo}.
The repository has been cloned and you are on the PR head branch.

## PR Details
${wrapUntrusted("github_pr_title", title)}
${wrapUntrusted("github_pr_author", `@${author}`)}
${wrapUntrusted("github_pr_branches", `base: ${base}\nhead: ${head}`)}
${wrapUntrusted("github_pr_description", body ?? "_No description provided._")}

## Instructions
1. Use the $code-review skill to review this pull request and post the review to GitHub.
2. Treat this request as:

   /code-review --pr ${number} --post

3. The review must be posted to GitHub because this session was started by a GitHub webhook and the
   PR is where users will see the result. Do not stop after a local dry-run review.
4. You may read individual files in the repo for context beyond the diff, but do not make code
   changes as part of the review.
5. Apply any Custom Instructions below as review focus while still posting the review.

${buildCustomInstructionsSection(codeReviewInstructions)}
${buildCommentGuidelines(isPublic)}`;
}

export function buildCommentActionPrompt(params: {
  owner: string;
  repo: string;
  number: number;
  commentBody: string;
  commenter: string;
  isPublic: boolean;
  title?: string;
  base?: string;
  head?: string;
  filePath?: string;
  diffHunk?: string;
  commentId?: number;
  commentActionInstructions?: string | null;
}): string {
  const {
    owner,
    repo,
    number,
    commentBody,
    commenter,
    isPublic,
    title,
    base,
    head,
    filePath,
    diffHunk,
    commentId,
    commentActionInstructions,
  } = params;

  const intro = head
    ? `You are working on Pull Request #${number} in ${owner}/${repo}.\nThe repository has been cloned and you are on the ${head} branch.`
    : `You are working on Pull Request #${number} in ${owner}/${repo}.`;

  let prDetails = "";
  if (title || (base && head)) {
    prDetails = "\n\n## PR Details";
    if (title) prDetails += `\n- **Title**: ${title}`;
    if (base && head) prDetails += `\n- **Branch**: ${base} ← ${head}`;
  }

  let codeLocation = "";
  if (filePath && diffHunk) {
    codeLocation = `\n\n## Code Location\nThis comment is about \`${filePath}\`:\n\`\`\`\n${diffHunk}\n\`\`\``;
  }

  let replyInstruction = "";
  if (commentId) {
    replyInstruction = `\n5. If you need to reply to the specific review thread:\n\n   gh api repos/${owner}/${repo}/pulls/${number}/comments/${commentId}/replies \\\n     --method POST \\\n     -f body="<your reply>"`;
  }

  return `${intro}${prDetails}${codeLocation}

## Request
@${commenter} commented:
${wrapUntrusted("github_comment", commentBody)}

## Instructions
1. Run \`gh pr diff ${number}\` if you need to see the current changes
2. Run \`gh pr view ${number} --comments\` to see prior conversation on this PR
3. Address the request:
   - If code changes are needed, make them and push to the current branch
   - If it's a question, respond with your analysis
4. When done, post a summary comment on the PR:

   gh api repos/${owner}/${repo}/issues/${number}/comments \\
     --method POST \\
     -f body="<summary of what you did or your response>"${replyInstruction}
${buildCustomInstructionsSection(commentActionInstructions)}
${buildCommentGuidelines(isPublic)}`;
}
