import { resolveAppName } from "@open-inspect/shared/app-name";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { z } from "zod";
import {
  fetchWithTimeout,
  getCachedInstallationToken,
  getGitHubAppConfig,
} from "../auth/github-app";
import type { Env } from "../types";

const GITHUB_API_BASE = "https://api.github.com";
const MAX_REVIEW_BODY_CHARS = 4_000;
const MAX_INLINE_COMMENT_BODY_CHARS = 2_000;
const MAX_INLINE_COMMENTS_PER_REVIEW = 15;
const MAX_EMBEDDED_REVIEW_CHARS = 48_000;

const reviewSchema = z.object({
  id: z.number().int().positive(),
  body: z.string().nullable().optional(),
  state: z.string(),
  html_url: z.string().optional(),
  submitted_at: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
});

const reviewCommentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  path: z.string(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  side: z.string().nullable().optional(),
  html_url: z.string().optional(),
  user: z.object({ login: z.string() }).nullable().optional(),
});

const reviewCommentsSchema = z.array(reviewCommentSchema);

export interface GitHubReviewInlineComment {
  id: number;
  author: string | null;
  body: string;
  path: string;
  line: number | null;
  side: string | null;
  url: string | null;
}

export interface GitHubReviewContent {
  id: number;
  author: string | null;
  body: string | null;
  state: string;
  url: string | null;
  submittedAt: string | null;
  inlineComments: GitHubReviewInlineComment[];
}

export interface GitHubReviewContentLoader {
  load(params: {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    reviewIds: number[];
  }): Promise<GitHubReviewContent[]>;
}

interface GitHubReviewContentClientDeps {
  getToken(forceRefresh: boolean): Promise<string>;
  fetch(url: string, init: RequestInit): Promise<Response>;
  userAgent: string;
}

export class GitHubReviewContentClient implements GitHubReviewContentLoader {
  constructor(private readonly deps: GitHubReviewContentClientDeps) {}

  async load(params: {
    repoOwner: string;
    repoName: string;
    prNumber: number;
    reviewIds: number[];
  }): Promise<GitHubReviewContent[]> {
    const results = await Promise.allSettled(
      params.reviewIds.map((reviewId) => this.loadReview(params, reviewId))
    );
    const reviews = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    );
    if (reviews.length === 0 && results.length > 0) {
      throw new AggregateError(
        results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        "Failed to load every GitHub review in the batch"
      );
    }
    return reviews;
  }

  private async loadReview(
    params: { repoOwner: string; repoName: string; prNumber: number },
    reviewId: number
  ): Promise<GitHubReviewContent> {
    const repositoryPath = `${encodeURIComponent(params.repoOwner)}/${encodeURIComponent(params.repoName)}`;
    const reviewPath = `/repos/${repositoryPath}/pulls/${params.prNumber}/reviews/${reviewId}`;
    const [reviewRaw, commentsRaw] = await Promise.all([
      this.getJson(reviewPath),
      this.getJson(`${reviewPath}/comments?per_page=100`),
    ]);
    const review = reviewSchema.parse(reviewRaw);
    const comments = reviewCommentsSchema.parse(commentsRaw);

    return {
      id: review.id,
      author: review.user?.login ?? null,
      body: review.body ?? null,
      state: review.state,
      url: review.html_url ?? null,
      submittedAt: review.submitted_at ?? null,
      inlineComments: comments.map((comment) => ({
        id: comment.id,
        author: comment.user?.login ?? null,
        body: comment.body,
        path: comment.path,
        line: comment.line ?? comment.original_line ?? null,
        side: comment.side ?? null,
        url: comment.html_url ?? null,
      })),
    };
  }

  private async getJson(path: string): Promise<unknown> {
    let response!: Response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.deps.getToken(attempt > 0);
      response = await this.deps.fetch(`${GITHUB_API_BASE}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": this.deps.userAgent,
        },
      });
      if (response.status !== 401) break;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch GitHub review content: ${response.status}`);
    }
    return response.json();
  }
}

export function createGitHubReviewContentLoader(env: Env): GitHubReviewContentLoader {
  const appConfig = getGitHubAppConfig(env);
  const cacheBindings = {
    cacheStore: createKvCacheStore(env.REPOS_CACHE),
    userAgent: resolveAppName(env),
  };
  return new GitHubReviewContentClient({
    getToken: (forceRefresh) => {
      if (!appConfig) throw new Error("GitHub App is not configured");
      return getCachedInstallationToken(appConfig, cacheBindings, { forceRefresh });
    },
    fetch: (url, init) => fetchWithTimeout(url, init),
    userAgent: cacheBindings.userAgent,
  });
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated; refresh GitHub for the complete text]`;
}

function wrapCdata(value: string): string {
  // Preserve code-heavy review text while preventing reviewer content from
  // closing the XML envelope. Splitting the CDATA terminator is valid XML.
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function formatReview(review: GitHubReviewContent): string {
  const attributes = [
    `id="${review.id}"`,
    `state="${escapeXmlAttribute(review.state)}"`,
    ...(review.author ? [`author="${escapeXmlAttribute(review.author)}"`] : []),
    ...(review.url ? [`url="${escapeXmlAttribute(review.url)}"`] : []),
  ];
  const lines = [`  <review ${attributes.join(" ")}>`];
  if (review.body?.trim()) {
    lines.push(
      "    <comment>",
      wrapCdata(truncate(review.body, MAX_REVIEW_BODY_CHARS)),
      "    </comment>"
    );
  }
  for (const comment of review.inlineComments.slice(0, MAX_INLINE_COMMENTS_PER_REVIEW)) {
    const commentAttributes = [
      `id="${comment.id}"`,
      `path="${escapeXmlAttribute(comment.path)}"`,
      ...(comment.line !== null ? [`line="${comment.line}"`] : []),
      ...(comment.side ? [`side="${escapeXmlAttribute(comment.side)}"`] : []),
      ...(comment.author ? [`author="${escapeXmlAttribute(comment.author)}"`] : []),
      ...(comment.url ? [`url="${escapeXmlAttribute(comment.url)}"`] : []),
    ];
    lines.push(
      `    <inline-comment ${commentAttributes.join(" ")}>`,
      wrapCdata(truncate(comment.body, MAX_INLINE_COMMENT_BODY_CHARS)),
      "    </inline-comment>"
    );
  }
  if (review.inlineComments.length > MAX_INLINE_COMMENTS_PER_REVIEW) {
    lines.push(
      "    <truncated>Additional inline comments were omitted. Refresh GitHub for the complete review.</truncated>"
    );
  }
  lines.push("  </review>");
  return lines.join("\n");
}

export function formatGitHubReviews(reviewIds: number[], reviews: GitHubReviewContent[]): string {
  const byId = new Map(reviews.map((review) => [review.id, review]));
  const blocks: string[] = [];
  let length = "<reviews>\n\n</reviews>".length;

  for (const reviewId of reviewIds) {
    const review = byId.get(reviewId);
    const block = review
      ? formatReview(review)
      : `  <review id="${reviewId}">\n    <comment>Review content was unavailable. Refresh GitHub for the current review.</comment>\n  </review>`;
    if (length + block.length > MAX_EMBEDDED_REVIEW_CHARS) {
      blocks.push(
        "  <truncated>Additional reviews were omitted. Refresh GitHub for the complete batch.</truncated>"
      );
      break;
    }
    blocks.push(block);
    length += block.length;
  }

  return `<reviews>\n${blocks.join("\n")}\n</reviews>`;
}
