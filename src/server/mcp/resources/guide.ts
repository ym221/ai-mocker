import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Task 1.5 会写出完整版指南文本。此处先占位。 */
export function registerGuideResource(server: McpServer): void {
  server.registerResource(
    'mockforge-guide',
    'mockforge://guide',
    {
      title: 'MockForge Usage Guide',
      description: 'How to use MockForge MCP tools effectively',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: '# MockForge MCP Guide\n\n(Placeholder — full content in Task 1.5)\n',
          },
        ],
      };
    }
  );
}
