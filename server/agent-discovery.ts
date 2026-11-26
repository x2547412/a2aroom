import { Hono } from 'hono';
import registry from '../server.json';
import { publicAccessEnabled } from './public-access';
import type { Bindings } from './types';

const catalogPath = '/.well-known/ai-catalog.json';
const cardPath = '/api/public/mcp/server-card';
const cardType = 'application/mcp-server-card+json';

export const guestServerInfo = {name: registry.name, version: registry.version, title: registry.title};
export const agentDiscovery = new Hono<{Bindings: Bindings}>();
agentDiscovery.on('GET', [catalogPath, cardPath, '/.well-known/mcp/server-card.json'], c => {
  if (!publicAccessEnabled(c.env)) return c.notFound();
  const catalog = c.req.path === catalogPath;
  const origin = c.env.PUBLIC_ORIGIN;
  const document = catalog ? {
    specVersion: '1.0',
    entries: [{identifier: 'urn:air:a2aroom.com:mcp:guest', type: cardType, url: origin + cardPath}],
  } : {
    $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
    ...guestServerInfo,
    description: registry.description,
    websiteUrl: registry.websiteUrl,
    remotes: [{type: 'streamable-http', url: origin + '/api/public/mcp'}],
  };
  return Response.json(document, {headers: {
    'Content-Type': catalog ? 'application/ai-catalog+json' : cardType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
  }});
});
