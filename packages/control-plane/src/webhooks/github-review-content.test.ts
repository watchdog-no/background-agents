import { describe, expect, it, vi } from "vitest";
import {
  GitHubReviewContentClient,
  formatGitHubReviews,
  type GitHubReviewContent,
} from "./github-review-content";

describe("GitHubReviewContentClient", () => {
  it("loads a review and its inline comments", async () => {
    const fetch = vi.fn(async (url: string, _init: RequestInit) => {
      if (url.endsWith("/comments?per_page=100")) {
        return Response.json([
          {
            id: 901,
            body: "Guard this branch",
            path: "src/index.ts",
            line: 42,
            side: "RIGHT",
            html_url: "https://github.com/acme/web/pull/12#discussion_r901",
            user: { login: "review-agent" },
          },
        ]);
      }
      return Response.json({
        id: 77,
        body: "Review body",
        state: "COMMENTED",
        html_url: "https://github.com/acme/web/pull/12#pullrequestreview-77",
        submitted_at: "2026-08-29T08:00:00Z",
        user: { login: "review-agent" },
      });
    });
    const client = new GitHubReviewContentClient({
      getToken: vi.fn().mockResolvedValue("installation-token"),
      fetch,
      userAgent: "Open Inspect",
    });

    await expect(
      client.load({ repoOwner: "acme", repoName: "web", prNumber: 12, reviewIds: [77] })
    ).resolves.toEqual([
      {
        id: 77,
        author: "review-agent",
        body: "Review body",
        state: "COMMENTED",
        url: "https://github.com/acme/web/pull/12#pullrequestreview-77",
        submittedAt: "2026-08-29T08:00:00Z",
        inlineComments: [
          {
            id: 901,
            author: "review-agent",
            body: "Guard this branch",
            path: "src/index.ts",
            line: 42,
            side: "RIGHT",
            url: "https://github.com/acme/web/pull/12#discussion_r901",
          },
        ],
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/acme/web/pulls/12/reviews/77"
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.github.com/repos/acme/web/pulls/12/reviews/77/comments?per_page=100"
    );
    expect(fetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer installation-token" }),
      })
    );
  });
});

describe("formatGitHubReviews", () => {
  it("embeds review and inline-comment content as escaped XML", () => {
    const reviews: GitHubReviewContent[] = [
      {
        id: 77,
        author: 'reviewer"bot',
        body: "Handle <edge> & retry",
        state: "COMMENTED",
        url: null,
        submittedAt: null,
        inlineComments: [
          {
            id: 901,
            author: "reviewer",
            body: "Use a <guard>",
            path: 'src/"index".ts',
            line: 42,
            side: "RIGHT",
            url: null,
          },
        ],
      },
    ];

    const content = formatGitHubReviews([77], reviews);

    expect(content).toContain('<review id="77" state="COMMENTED" author="reviewer&quot;bot">');
    expect(content).toContain("Handle &lt;edge&gt; &amp; retry");
    expect(content).toContain('path="src/&quot;index&quot;.ts" line="42"');
    expect(content).toContain("Use a &lt;guard&gt;");
    expect(content).not.toContain("untrusted");
  });

  it("marks omitted inline comments and missing review content", () => {
    const review: GitHubReviewContent = {
      id: 77,
      author: "reviewer",
      body: null,
      state: "COMMENTED",
      url: null,
      submittedAt: null,
      inlineComments: Array.from({ length: 16 }, (_, index) => ({
        id: 900 + index,
        author: "reviewer",
        body: `Comment ${index}`,
        path: "src/index.ts",
        line: index + 1,
        side: "RIGHT",
        url: null,
      })),
    };

    const content = formatGitHubReviews([77, 88], [review]);

    expect(content).toContain("Additional inline comments were omitted");
    expect(content).toContain('<review id="88">');
    expect(content).toContain("Review content was unavailable");
  });
});
