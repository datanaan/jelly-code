/**
 * MCP Tool: code_evolution_story
 *
 * Triggers asynchronous generation of an "evolution narrative" for a code
 * symbol — the story of how a function/class/method grew, split, merged, or
 * was renamed over time.
 *
 * Wraps WikiService.startEvolutionStoryGeneration(projectId, nodeId) which
 * kicks off P2-T3's narrator + anti-hallucination validator in the
 * background (via setImmediate) and returns a taskId immediately.
 *
 * The caller polls GET /api/wiki/evolution-story/:topicId (P2-T5) or
 * GET /api/wiki/status (T1) to track progress, then retrieves the finished
 * narrative once status === "done".
 *
 * Optional `refresh` flag is accepted for forward compatibility — the
 * current service always regenerates, but future versions may cache.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WikiService } from "../../wiki/service.js";

export function registerCodeEvolutionStory(
  server: McpServer,
  wikiService: WikiService,
): void {
  server.registerTool(
    "code_evolution_story",
    {
      description:
        "Trigger asynchronous generation of a code symbol's evolution " +
        "narrative — how it grew, split, merged, or was renamed over time. " +
        "Returns a taskId immediately; poll wiki_status or the REST endpoint " +
        "GET /api/wiki/evolution-story/:topicId to retrieve the finished story.",
      inputSchema: {
        projectId: z
          .string()
          .describe("Project ID to scope the evolution story to"),
        nodeId: z
          .string()
          .describe("Node ID of the code symbol to narrate"),
        refresh: z
          .boolean()
          .optional()
          .describe(
            "Reserved for future caching; current implementation always regenerates",
          ),
      },
    },
    async ({ projectId, nodeId }) => {
      try {
        const taskId = wikiService.startEvolutionStoryGeneration(
          projectId,
          nodeId,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  taskId,
                  status: "compiling",
                  message:
                    "Evolution story generation started. " +
                    "Poll wiki_status with the taskId or GET /api/wiki/evolution-story/:topicId " +
                    "to retrieve the result once done.",
                  projectId,
                  nodeId,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
