/**
 * Regression tests for repository reads discovered while validating repository archive downloads.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert";
import { HOST, launchServer, ServerInstance, TransportMode } from "./utils/server-launcher.js";
import { findMockServerPort, MockGitLabServer } from "./utils/mock-gitlab-server.js";

const MOCK_TOKEN = "glpat-repository-read-regressions";
const NEXT_CURSOR = "eyJmaWxlX25hbWUiOiJmaWxlXzk5LnR4dCJ9";

interface JsonRpcResult {
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
}

function parseSSE(text: string): JsonRpcResult[] {
  return text
    .split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => JSON.parse(line.slice(6)));
}

function parseToolText(result: JsonRpcResult): unknown {
  const block = result.result?.content?.find(item => item.type === "text");
  assert.ok(block?.text, `Expected tool text content: ${result.error?.message ?? "unknown error"}`);
  return JSON.parse(block.text);
}

describe("Repository read regressions", { timeout: 60_000 }, () => {
  let mockGitLab: MockGitLabServer;
  let server: ServerInstance;
  let serverPort: number;
  let sessionId: string;
  let observedProjectId: string | undefined;
  let observedPageToken: string | undefined;

  async function callTool(
    id: number,
    name: string,
    args: Record<string, unknown>
  ): Promise<JsonRpcResult> {
    const response = await fetch(`http://${HOST}:${serverPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Private-Token": MOCK_TOKEN,
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    assert.strictEqual(response.status, 200, `${name} should return HTTP 200`);
    const rpc = parseSSE(await response.text()).find(item => item.id === id);
    assert.ok(rpc, `${name} should return JSON-RPC result ${id}`);
    return rpc;
  }

  before(async () => {
    const mockPort = await findMockServerPort();
    mockGitLab = new MockGitLabServer({ port: mockPort, validTokens: [MOCK_TOKEN] });

    mockGitLab.addMockHandler("get", "/projects/:projectId", (req, res) => {
      observedProjectId = req.params.projectId;
      res.json({
        id: 94,
        name: "Tempo",
        path: "tempo",
        path_with_namespace: "frxyt/tempo",
      });
    });

    mockGitLab.addMockHandler("get", "/projects/:projectId/repository/tree", (req, res) => {
      const pageToken = typeof req.query.page_token === "string" ? req.query.page_token : undefined;
      observedPageToken = pageToken;

      if (pageToken) {
        res.json([
          {
            id: "final-tree-record",
            name: "final.txt",
            type: "blob",
            path: "final.txt",
            mode: "100644",
          },
        ]);
        return;
      }

      const items = Array.from({ length: 100 }, (_, index) => ({
        id: `tree-record-${index}`,
        name: `file-${index}.txt`,
        type: "blob",
        path: `file-${index}.txt`,
        mode: "100644",
      }));
      const nextUrl = new URL(
        `${mockGitLab.getUrl()}/api/v4/projects/${req.params.projectId}/repository/tree`
      );
      nextUrl.searchParams.set("pagination", "keyset");
      nextUrl.searchParams.set("per_page", "100");
      nextUrl.searchParams.set("page_token", NEXT_CURSOR);
      res.set("Link", `<${nextUrl.toString()}>; rel="next"`);
      // Some GitLab versions can expose a numeric X-Next-Page alongside keyset
      // pagination. That page number is not a valid repository-tree page_token.
      res.set("X-Next-Page", "2");
      res.json(items);
    });

    await mockGitLab.start();

    serverPort = 3521;
    server = await launchServer({
      mode: TransportMode.STREAMABLE_HTTP,
      port: serverPort,
      timeout: 10_000,
      env: {
        STREAMABLE_HTTP: "true",
        REMOTE_AUTHORIZATION: "true",
        MCP_TRUST_PROXY: "false",
        MCP_SERVER_URL: `http://${HOST}:${serverPort}`,
        GITLAB_API_URL: `${mockGitLab.getUrl()}/api/v4`,
      },
    });

    const initRes = await fetch(`http://${HOST}:${serverPort}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Private-Token": MOCK_TOKEN,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test-repository-read-regressions", version: "1.0" },
        },
      }),
    });
    assert.strictEqual(initRes.status, 200, "Initialize should succeed");
    sessionId = initRes.headers.get("mcp-session-id")!;
    assert.ok(sessionId, "Should receive a session ID");
  });

  after(async () => {
    if (server) server.kill();
    if (mockGitLab) await mockGitLab.stop();
  });

  test("get_project accepts an already URL-encoded project path", async () => {
    observedProjectId = undefined;
    const result = await callTool(2, "get_project", { project_id: "frxyt%2Ftempo" });
    assert.ok(result.result, `get_project should succeed: ${result.error?.message ?? ""}`);
    assert.strictEqual(observedProjectId, "frxyt/tempo");
    const project = parseToolText(result) as { id: number; path_with_namespace: string };
    assert.strictEqual(project.id, 94);
    assert.strictEqual(project.path_with_namespace, "frxyt/tempo");
  });

  test("get_repository_tree follows the keyset cursor from the Link header", async () => {
    observedPageToken = undefined;
    const first = await callTool(3, "get_repository_tree", {
      project_id: "94",
      ref: "master",
      recursive: true,
      pagination: "keyset",
      per_page: 100,
    });
    assert.ok(first.result, `first tree page should succeed: ${first.error?.message ?? ""}`);
    const firstPage = parseToolText(first) as {
      items: Array<{ id: string }>;
      next_page_token?: string;
    };
    assert.strictEqual(firstPage.items.length, 100);
    assert.strictEqual(firstPage.next_page_token, NEXT_CURSOR);
    assert.notStrictEqual(firstPage.next_page_token, "2");

    const second = await callTool(4, "get_repository_tree", {
      project_id: "94",
      ref: "master",
      recursive: true,
      pagination: "keyset",
      per_page: 100,
      page_token: firstPage.next_page_token,
    });
    assert.ok(second.result, `second tree page should succeed: ${second.error?.message ?? ""}`);
    assert.strictEqual(observedPageToken, NEXT_CURSOR);
    const secondPage = parseToolText(second) as {
      items: Array<{ id: string }>;
      next_page_token?: string;
    };
    assert.strictEqual(secondPage.items.length, 1);
    assert.strictEqual(secondPage.next_page_token, undefined);
  });
});
