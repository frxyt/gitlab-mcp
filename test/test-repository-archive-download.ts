/**
 * Repository archive download tool tests.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { gzipSync, gunzipSync } from 'node:zlib';
import { launchServer, TransportMode, ServerInstance, HOST } from './utils/server-launcher.js';
import { MockGitLabServer, findMockServerPort } from './utils/mock-gitlab-server.js';

const MOCK_TOKEN = 'glpat-repository-archive-test-token';
const TEST_PROJECT_ID = '123';
const ARCHIVE_PAYLOAD = Buffer.from('complete repository snapshot');
const FAKE_GZIP = gzipSync(ARCHIVE_PAYLOAD);

type ToolContent =
  | { type: 'text'; text?: string }
  | {
      type: 'resource';
      resource?: { uri: string; mimeType?: string; blob?: string };
    };

interface JsonRpcResult {
  id?: number;
  result?: { content?: ToolContent[] };
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
  let repositoryArchiveAccept: string | undefined;
  let repositoryArchiveFetchMode: string | undefined;

  before(async () => {
    const mockPort = await findMockServerPort();
    mockGitLab = new MockGitLabServer({
      port: mockPort,
      validTokens: [MOCK_TOKEN],
    });
    mockGitLab.addMockHandler(
      'get',
      `/projects/${TEST_PROJECT_ID}/repository/archive.tar.gz`,
      (req, res) => {
        repositoryArchiveQuery = req.query as Record<string, unknown>;
        repositoryArchiveAccept = req.headers.accept;
        repositoryArchiveFetchMode = req.headers['sec-fetch-mode'];
        if (repositoryArchiveAccept !== '*/*' || repositoryArchiveFetchMode !== 'same-origin') {
          res.status(406).json({ message: '406 Not Acceptable' });
          return;
        }
        // GitLab may use a generic content type for downloads; the MCP tool must
        // still expose the archive with the MIME type implied by the requested format.
        res.set('Content-Type', 'application/octet-stream');
        res.set('Content-Disposition', 'attachment; filename="repository-main.tar.gz"');
        res.send(FAKE_GZIP);
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

  test('returns the tar.gz directly as an embedded MCP resource', async () => {
    repositoryArchiveQuery = {};
    repositoryArchiveAccept = undefined;
    repositoryArchiveFetchMode = undefined;
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
            format: 'tar.gz',
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

    const resourceBlock = result.result.content?.find(
      (item): item is Extract<ToolContent, { type: 'resource' }> => item.type === 'resource'
    );
    assert.ok(resourceBlock?.resource, 'Should have embedded resource content');
    assert.strictEqual(resourceBlock.resource.mimeType, 'application/gzip');
    assert.ok(resourceBlock.resource.uri.endsWith('/repository_archive.tar.gz?sha=main&path=src'));
    assert.ok(resourceBlock.resource.blob, 'Embedded resource should contain base64 data');

    const archive = Buffer.from(resourceBlock.resource.blob, 'base64');
    assert.deepStrictEqual(archive, FAKE_GZIP, 'MCP resource should contain the GitLab archive bytes');
    assert.deepStrictEqual(gunzipSync(archive), ARCHIVE_PAYLOAD, 'Returned resource should be valid gzip');

    const textBlock = result.result.content?.find(
      (item): item is Extract<ToolContent, { type: 'text' }> => item.type === 'text'
    );
    assert.ok(textBlock?.text, 'Should also include archive metadata');
    const metadata = JSON.parse(textBlock.text);
    assert.strictEqual(metadata.filename, 'repository_archive.tar.gz');
    assert.strictEqual(metadata.mime_type, 'application/gzip');
    assert.strictEqual(metadata.size, FAKE_GZIP.byteLength);
    assert.ok(!('download_url' in metadata), 'Remote result must not require a secondary URL fetch');

    assert.strictEqual(repositoryArchiveAccept, '*/*');
    assert.strictEqual(repositoryArchiveFetchMode, 'same-origin');
    assert.strictEqual(repositoryArchiveQuery.sha, 'main');
    assert.strictEqual(repositoryArchiveQuery.path, 'src');
    assert.strictEqual(repositoryArchiveQuery.exclude_paths, 'dist,tmp');
    assert.strictEqual(repositoryArchiveQuery.include_lfs_blobs, 'false');
    assert.strictEqual(repositoryArchiveQuery.ref_type, 'branch');
  });
});
