import { z } from "zod";

// A leaf module so sandbox-events can validate `user_message.source` without
// importing sessions.ts, which itself imports sandbox-events.
export const messageSourceSchema = z.enum([
  "web",
  "slack",
  "linear",
  "extension",
  "github",
  // Retired: the fork's GitHub review follow-up, replaced by Autofix. Nothing
  // writes it any more, but sessions from before the switch have persisted
  // `user_message` events carrying it, and dropping the value would make
  // sandboxEventSchema reject those events and quietly erase them from the
  // timeline.
  "github-review",
  "automation",
  "agent",
]);
export type MessageSource = z.infer<typeof messageSourceSchema>;
