/**
 * Repository archive download tool tests.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { launchServer, TransportMode, ServerInstance, HOST } from './utils/server-launcher.js';
import { MockGitLabServer, findMockServerPort } from './utils/mock-gitlab-server.js';

const MOCK_TOKEN = 'glpat-repository-archive-test-token';
const TEST_PROJECT_ID = '123';
const FAKE_ZIP = Buffer.from('PK\x03\x04fake-repository-archive');

interface JsonRpcResult {
  id?: number;
  result?: { content?: Array<{ type: string; text?: string }> };
  error?: { code: number; message: string };
}

function parseSSE(text: string): JsonRpcResult[] {
  return text
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

describe('Repository archive download', { timeout: 60_000 }, () => {
  let mockGitLab: MockGitLabServer;
  let server: ServerInstance;
  let serverPort: number;
  let sessionId: string;
  let repositoryArchiveQuery: Record<string, unknown> = {};

  before(async () => {
    const mockPort = await findMockServerPort();
    mockGitLab = new MockGitLabServer({
      port: mockPort,
      validTokens: [MOCK_TOKEN],
    });
    mockGitLab.addMockHandler(
      'get',
      `/projects/${TEST_PROJECT_ID}/repository/archive.zip`,
      (req, res) => {
        repositoryArchiveQuery = req.query as Record<string, unknown>;
        res.set('Content-Type', 'application/zip');
        res.set('Content-Disposition', 'attachment; filename="repository-main.zip"');
        res.send(FAKE_ZIP);
      }
    );
    await mockGitLab.start();

    serverPort = 3520;
    server = await launchServer({
      mode: TransportMode.STREAMABLE_HTTP,
      port: serverPort,
      timeout: 10_000,
      env: {
        STREAMABLE_HTTP: 'true',
        REMOTE_AUTHORIZATION: 'true',
        MCP_TRUST_PROXY: 'false',
        MCP_SERVER_URL: `http://${HOST}:${serverPort}`,
        GITLAB_API_URL: `${mockGitLab.getUrl()}/api/v4`,
      },
    });

    const initRes = await fetch(`http://${HOST}:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Private-Token': MOCK_TOKEN,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-repository-archive-download', version: '1.0' },
        },
      }),
    });
    assert.strictEqual(initRes.status, 200, 'Initialize should succeed');
    sessionId = initRes.headers.get('mcp-session-id')!;
    assert.ok(sessionId, 'Should receive a session ID');
  });

  after(async () => {
    if (server) server.kill();
    if (mockGitLab) await mockGitLab.stop();
  });

  test('returns a signed URL and forwards repository archive options', async () => {
    repositoryArchiveQuery = {};
    const toolRes = await fetch(`http://${HOST}:${serverPort}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Private-Token': MOCK_TOKEN,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'download_repository_archive',
          arguments: {
            project_id: TEST_PROJECT_ID,
            format: 'zip',
            sha: 'main',
            path: 'src',
            exclude_paths: 'dist,tmp',
            include_lfs_blobs: false,
            ref_type: 'branch',
          },
        },
      }),
    });
    assert.strictEqual(toolRes.status, 200, 'Tool call should return 200');
    const result = parseSSE(await toolRes.text()).find(item => item.id === 2);
    assert.ok(result?.result, `Tool should return a result: ${result?.error?.message ?? ''}`);

    const textBlock = result.result.content?.find(item => item.type === 'text');
    assert.ok(textBlock?.text, 'Should have text content');
    const parsed = JSON.parse(textBlock.text);
    assert.ok(parsed.download_url.includes('/downloads/repository-archive'));
    assert.ok(parsed.download_url.includes('_token='), 'URL should contain embedded auth token');
    assert.strictEqual(parsed.filename, 'repository_archive.zip');

    const downloadRes = await fetch(parsed.download_url);
    assert.strictEqual(downloadRes.status, 200, 'Download URL should work without auth headers');
    const body = Buffer.from(await downloadRes.arrayBuffer());
    assert.ok(body.includes(Buffer.from('PK')), 'Should contain zip magic bytes');
    assert.strictEqual(repositoryArchiveQuery.sha, 'main');
    assert.strictEqual(repositoryArchiveQuery.path, 'src');
    assert.strictEqual(repositoryArchiveQuery.exclude_paths, 'dist,tmp');
    assert.strictEqual(repositoryArchiveQuery.include_lfs_blobs, 'false');
    assert.strictEqual(repositoryArchiveQuery.ref_type, 'branch');
  });
});
